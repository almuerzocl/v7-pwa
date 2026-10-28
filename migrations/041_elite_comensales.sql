-- 041 · ELITE de comensales: períodos de 30 días, is_elite() y reputación efectiva
--
-- Regla de negocio (producto «Suscripción ELITE» de la tienda, SKU COM-ELITE):
--   · una cuenta ELITE (un solo correo) no tiene tope de operaciones y su reputación se mantiene en 100 %;
--   · cada pago de Shopify (o cada renovación del cobro recurrente) suma un período de 30 días; los pagos adelantados se
--     encadenan detrás del período que corre (mismo motor que los planes de restaurante: admin-dashboard `plan-periods.ts`);
--   · al vencer, la cuenta vuelve a `free` y recupera su reputación REAL (nunca se sobrescribe: `calculate_daily_reputation` no cambia).
--
-- Fuente de verdad: `public.is_elite(user)` decide por FECHAS sobre `elite_periods` (no por `profiles.account_type`).
-- `profiles.account_type` queda como CACHÉ para la interfaz: lo mantiene un trigger sobre `elite_periods` (al instante) y el job
-- horario del admin vía `elite_sync_all()` (vencimientos por fecha, que no tocan ninguna fila). Nadie debe editarlo a mano:
-- una cortesía se otorga como período sin pedido (`order_id` nulo).
-- Gracia: `is_elite()` sigue verdadero 3 días después de que termina un período no anulado (cobro recurrente pagado con retraso).
-- La gracia no se acumula: se mide siempre desde el fin del período. Un período anulado (reembolso/cancelación) no tiene gracia.
--
-- Quién escribe: SOLO el admin-dashboard (único repo que habla con Shopify) con service_role. Los demás leen.
--
-- Qué cambia en funciones existentes (cuerpos tomados de producción con pg_get_functiondef el 2026-10-25):
--   · operation_limit_check / operation_usage (040): «sin límite» se decide con is_elite() en vez de account_type.
--   · auto_approve_reservation / auto_approve_takeaway_order: la reputación que se compara con el mínimo del local es
--     effective_reputation() (100 si es ELITE). Los demás criterios (cupo, monto, plan del local) no cambian.
--   · create_reservation_atomic NO cambia: el snapshot de reputación lo manda la PWA desde el servidor (effective_reputation).
--
-- Orden de despliegue: esta migración ANTES del admin-dashboard (que escribe elite_periods) y de la PWA (que lee el estado).
-- Con la tabla vacía nadie es ELITE: aplicar la migración no cambia el comportamiento de ninguna cuenta.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Períodos
-- ---------------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.elite_periods (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    -- Pedido de Shopify de origen; nulo en una cortesía otorgada a mano.
    order_id    bigint,
    line_index  integer,
    unit_index  integer NOT NULL DEFAULT 0,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    status      text NOT NULL DEFAULT 'en_cola' CHECK (status IN ('en_cola', 'vigente', 'vencido', 'anulado')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT elite_periods_dates CHECK (ends_at > starts_at)
);

-- Idempotencia del webhook: una unidad comprada (pedido:línea:unidad) existe una sola vez.
CREATE UNIQUE INDEX IF NOT EXISTS elite_periods_unit_key ON public.elite_periods (order_id, line_index, unit_index) WHERE order_id IS NOT NULL;
-- Un solo período corriendo por cuenta.
CREATE UNIQUE INDEX IF NOT EXISTS elite_periods_one_running ON public.elite_periods (user_id) WHERE status = 'vigente';
CREATE INDEX IF NOT EXISTS elite_periods_user_idx ON public.elite_periods (user_id);
CREATE INDEX IF NOT EXISTS elite_periods_order_idx ON public.elite_periods (order_id) WHERE order_id IS NOT NULL;

ALTER TABLE public.elite_periods ENABLE ROW LEVEL SECURITY;
-- Supabase da a service_role todos los privilegios en tablas nuevas: se quita lo que sobra. Sin DELETE: un período se anula, no se borra.
REVOKE ALL ON public.elite_periods FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.elite_periods TO service_role;

-- Avisos por correo (una vez por pedido y tipo, con reclamo atómico y tope de intentos, como las confirmaciones de reservas).
CREATE TABLE IF NOT EXISTS public.elite_notices (
    order_id    bigint NOT NULL,
    kind        text   NOT NULL CHECK (kind IN ('bienvenida', 'sin_cuenta')),
    attempts    integer NOT NULL DEFAULT 0,
    claimed_at  timestamptz,
    sent_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, kind)
);
ALTER TABLE public.elite_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.elite_notices FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.elite_notices TO service_role;

-- Búsqueda de la cuenta del comprador por correo (el admin cruza el correo del pedido de Shopify con profiles.email).
CREATE INDEX IF NOT EXISTS profiles_email_lower_idx ON public.profiles (lower(email));

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Funciones
-- ---------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_elite(p_user uuid, p_now timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.elite_periods e
        WHERE e.user_id = p_user
          AND e.status <> 'anulado'
          AND e.starts_at <= p_now
          AND p_now < e.ends_at + interval '3 days'
    );
$$;

-- Reputación que valen los criterios de aprobación: 100 para una cuenta ELITE; si no, la real del perfil (puede ser NULL).
CREATE OR REPLACE FUNCTION public.effective_reputation(p_user uuid, p_scope text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v integer;
BEGIN
    IF p_scope NOT IN ('reservation', 'takeaway') THEN
        RAISE EXCEPTION 'effective_reputation: ámbito inválido (%)', p_scope USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF public.is_elite(p_user) THEN RETURN 100; END IF;
    SELECT CASE p_scope WHEN 'reservation' THEN p.reservation_reputation ELSE p.takeaway_reputation END
      INTO v FROM public.profiles p WHERE p.id = p_user;
    RETURN v;
END;
$$;

-- La cuenta cuyo correo coincide (sin mayúsculas ni espacios) con p_email, solo si es ÚNICA; NULL si no hay o si hay varias.
CREATE OR REPLACE FUNCTION public.elite_profile_by_email(p_email text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    ids uuid[];
BEGIN
    IF p_email IS NULL OR btrim(p_email) = '' THEN RETURN NULL; END IF;
    SELECT array_agg(p.id) INTO ids FROM public.profiles p WHERE lower(btrim(p.email)) = lower(btrim(p_email));
    IF ids IS NULL OR array_length(ids, 1) <> 1 THEN RETURN NULL; END IF;
    RETURN ids[1];
END;
$$;

-- Caché account_type de UNA cuenta.
CREATE OR REPLACE FUNCTION public.elite_sync_user(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    IF public.is_elite(p_user) THEN
        UPDATE public.profiles SET account_type = 'elite' WHERE id = p_user AND account_type <> 'elite';
    ELSE
        UPDATE public.profiles SET account_type = 'free' WHERE id = p_user AND account_type = 'elite';
    END IF;
END;
$$;

-- Caché de todas las cuentas (job horario del admin: un vencimiento por fecha no cambia ninguna fila por sí solo).
-- Devuelve cuántas cuentas cambiaron.
CREATE OR REPLACE FUNCTION public.elite_sync_all()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    up integer; down integer;
BEGIN
    UPDATE public.profiles p SET account_type = 'elite'
     WHERE p.account_type <> 'elite' AND public.is_elite(p.id)
       AND p.id IN (SELECT user_id FROM public.elite_periods);
    GET DIAGNOSTICS up = ROW_COUNT;
    UPDATE public.profiles p SET account_type = 'free'
     WHERE p.account_type = 'elite' AND NOT public.is_elite(p.id);
    GET DIAGNOSTICS down = ROW_COUNT;
    RETURN up + down;
END;
$$;

CREATE OR REPLACE FUNCTION public.elite_periods_sync_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    PERFORM public.elite_sync_user(NEW.user_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_elite_periods_sync ON public.elite_periods;
CREATE TRIGGER tr_elite_periods_sync
    AFTER INSERT OR UPDATE OF status, starts_at, ends_at ON public.elite_periods
    FOR EACH ROW EXECUTE FUNCTION public.elite_periods_sync_trigger();

-- Solo service_role (y los triggers, que corren como dueño). Ni anon ni authenticated pueden llamarlas por la API.
REVOKE EXECUTE ON FUNCTION public.is_elite(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.effective_reputation(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.elite_profile_by_email(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.elite_sync_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.elite_sync_all() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.elite_periods_sync_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_elite(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.effective_reputation(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.elite_profile_by_email(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.elite_sync_user(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.elite_sync_all() TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Límites de operaciones (040): «sin límite» por is_elite()
-- ---------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.operation_limit_check(p_user uuid, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    cfg  public.operation_limits%ROWTYPE;
    c    record;
    w    record;
BEGIN
    IF p_user IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO cfg FROM public.operation_limits LIMIT 1;
    IF NOT FOUND OR NOT cfg.enabled THEN RETURN NULL; END IF;
    IF public.is_elite(p_user, p_now) THEN RETURN NULL; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('operation_limits:' || p_user::text, 0));
    SELECT * INTO c FROM public.operation_counts(p_user, p_now);
    SELECT * INTO w FROM public.operation_windows(p_now);
    IF c.weekly_used >= cfg.weekly_limit THEN
        RETURN jsonb_build_object('limit', 'weekly', 'limit_value', cfg.weekly_limit, 'used', c.weekly_used, 'resets_at', w.next_week);
    ELSIF c.daily_used >= cfg.daily_limit THEN
        RETURN jsonb_build_object('limit', 'daily', 'limit_value', cfg.daily_limit, 'used', c.daily_used, 'resets_at', w.next_day);
    END IF;
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.operation_usage(p_user uuid, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    cfg   public.operation_limits%ROWTYPE;
    c     record;
    w     record;
    elite boolean;
BEGIN
    SELECT * INTO cfg FROM public.operation_limits LIMIT 1;
    elite := COALESCE(public.is_elite(p_user, p_now), false);
    SELECT * INTO c FROM public.operation_counts(p_user, p_now);
    SELECT * INTO w FROM public.operation_windows(p_now);
    RETURN jsonb_build_object(
        'enabled', COALESCE(cfg.enabled, false),
        'elite', elite,
        'limited', COALESCE(cfg.enabled, false) AND NOT elite,
        'daily_used', c.daily_used, 'daily_limit', cfg.daily_limit, 'daily_resets_at', w.next_day,
        'weekly_used', c.weekly_used, 'weekly_limit', cfg.weekly_limit, 'weekly_resets_at', w.next_week
    );
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Autoaprobación: la reputación comparada con el mínimo del local es la efectiva
-- ---------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_approve_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_settings jsonb; v_max_pax integer; v_min_reputation integer; v_takeaway_reputation integer; v_reservation_reputation integer; v_restaurant_name text;
BEGIN
    IF NEW.organizer_id IS NULL THEN RAISE EXCEPTION 'reservations: organizer_id es obligatorio (toda transaccion requiere identificacion)' USING ERRCODE = 'not_null_violation'; END IF;
    SELECT takeaway_reputation, reservation_reputation INTO v_takeaway_reputation, v_reservation_reputation FROM public.profiles WHERE id = NEW.organizer_id;
    IF v_takeaway_reputation IS NULL OR v_reservation_reputation IS NULL OR v_takeaway_reputation NOT BETWEEN 0 AND 100 OR v_reservation_reputation NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'reservations: el usuario % no tiene reputacion valida (0-100) en todos sus ambitos', NEW.organizer_id USING ERRCODE = 'check_violation';
    END IF;
    -- ELITE: la reputación vale 100 mientras la cuenta esté vigente (la real queda intacta en el perfil).
    v_reservation_reputation := public.effective_reputation(NEW.organizer_id, 'reservation');
    IF NOT public.restaurant_plan_allows(NEW.restaurant_id) THEN RETURN NEW; END IF;
    SELECT reservation_settings INTO v_settings FROM public.restaurants WHERE id = NEW.restaurant_id;
    IF v_settings IS NULL THEN RETURN NEW; END IF;
    v_max_pax := (v_settings->>'max_party_size')::integer; v_min_reputation := (v_settings->>'min_reputation')::integer;
    IF v_max_pax IS NULL OR v_min_reputation IS NULL THEN RETURN NEW; END IF;
    IF NEW.status = 'PENDIENTE' AND NEW.party_size <= v_max_pax AND v_reservation_reputation >= v_min_reputation THEN
        NEW.status := 'CONFIRMADA'; NEW.approved_at := now(); NEW.confirmed_at := now();
        NEW.timestamps := COALESCE(NEW.timestamps, '{}'::jsonb) || jsonb_build_object('CONFIRMADA', jsonb_build_object(
            'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'actor_id', NEW.organizer_id::text, 'actor_role', 'system',
            'reason', format('Auto-aprobada: reputacion %s >= %s, grupo %s <= %s', v_reservation_reputation, v_min_reputation, NEW.party_size, v_max_pax)));
        BEGIN
            SELECT name INTO v_restaurant_name FROM public.restaurants WHERE id = NEW.restaurant_id;
            INSERT INTO public.notifications (user_id, restaurant_id, type, title, message, related_id, priority, actor_id, actor_role)
            VALUES (NEW.organizer_id, NEW.restaurant_id, 'RESERVATION', COALESCE(v_restaurant_name, 'Restaurante'), 'Tu reserva ha sido confirmada', NEW.id, 'NORMAL', NEW.organizer_id, 'system');
        EXCEPTION WHEN OTHERS THEN RAISE WARNING 'auto_approve_reservation: no se pudo crear la notificacion (%): %', SQLSTATE, SQLERRM;
        END;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_approve_takeaway_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_settings jsonb; v_max_amount numeric; v_min_reputation integer; v_takeaway_reputation integer; v_reservation_reputation integer;
BEGIN
    IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'takeaway_orders: user_id es obligatorio (toda transaccion requiere identificacion)' USING ERRCODE = 'not_null_violation'; END IF;
    SELECT takeaway_reputation, reservation_reputation INTO v_takeaway_reputation, v_reservation_reputation FROM public.profiles WHERE id = NEW.user_id;
    IF v_takeaway_reputation IS NULL OR v_reservation_reputation IS NULL OR v_takeaway_reputation NOT BETWEEN 0 AND 100 OR v_reservation_reputation NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'takeaway_orders: el usuario % no tiene reputacion valida (0-100) en todos sus ambitos', NEW.user_id USING ERRCODE = 'check_violation';
    END IF;
    -- ELITE: la reputación vale 100 mientras la cuenta esté vigente (la real queda intacta en el perfil).
    v_takeaway_reputation := public.effective_reputation(NEW.user_id, 'takeaway');
    IF NOT public.restaurant_plan_allows(NEW.restaurant_id) THEN RETURN NEW; END IF;
    SELECT takeaway_settings INTO v_settings FROM public.restaurants WHERE id = NEW.restaurant_id;
    IF v_settings IS NULL THEN RETURN NEW; END IF;
    v_max_amount := (v_settings->>'max_order_amount')::numeric; v_min_reputation := (v_settings->>'min_reputation')::integer;
    IF v_max_amount IS NULL OR v_min_reputation IS NULL THEN RETURN NEW; END IF;
    IF (NEW.status IN ('PENDIENTE', 'CREADA')) AND NEW.total_amount <= v_max_amount AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA'; NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;
