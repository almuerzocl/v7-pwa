-- 040 · Límites de operaciones por cliente (cuenta gratuita)
--
-- Regla: un cliente con `profiles.account_type <> 'elite'` puede crear como máximo `daily_limit` operaciones por día y
-- `weekly_limit` por semana (por defecto 2 y 10). Una operación es una reserva O un pedido para llevar; ambas suman al mismo
-- contador. Las cuentas Elite no tienen límite. Día y semana son de calendario en America/Santiago (semana = lunes a domingo).
--
-- Qué cuenta (por cliente: reservations.organizer_id / takeaway_orders.user_id):
--   · todo lo que crea el propio cliente, incluido lo que él mismo cancela (si no, se burla creando y cancelando);
--   · NO cuentan: las RECHAZADA, las canceladas por el restaurante o por el sistema (actor distinto de user/customer en
--     `timestamps -> <estado> -> actor_role`) y las creadas por el personal (`created_by_staff`).
--
-- Dónde se aplica: en la BASE. Un trigger BEFORE INSERT en reservations y takeaway_orders (cubre el INSERT directo con la sesión
-- del usuario) más la verificación dentro de create_reservation_atomic (responde jsonb con code 'limit_reached'). Ambos toman un
-- advisory lock por usuario, así que dos peticiones simultáneas no se saltan el tope. Falla CERRADA: un error al contar aborta
-- el INSERT. Error con código estable: HINT 'limit_reached' y DETAIL con un JSON {limit, limit_value, used, resets_at}.
--
-- INTERRUPTOR: public.operation_limits.enabled (nace en false: desplegar la migración no cambia el comportamiento).
--     UPDATE public.operation_limits SET enabled = true;                         -- encender
--     UPDATE public.operation_limits SET daily_limit = 2, weekly_limit = 10;     -- valores
--
-- Orden de despliegue: aplicar esta migración ANTES de desplegar la PWA nueva (la PWA lee operation_usage) y de que el
-- restaurant-dashboard marque sus reservas manuales con created_by_staff. Con el interruptor apagado el código viejo sigue igual.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Configuración (una sola fila)
-- ---------------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.operation_limits (
    singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    enabled      boolean     NOT NULL DEFAULT false,
    daily_limit  integer     NOT NULL DEFAULT 2  CHECK (daily_limit  > 0),
    weekly_limit integer     NOT NULL DEFAULT 10 CHECK (weekly_limit > 0),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.operation_limits (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.operation_limits ENABLE ROW LEVEL SECURITY;
-- Supabase da a service_role todos los privilegios en tablas nuevas: se quita lo que sobra.
REVOKE ALL ON public.operation_limits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE ON public.operation_limits TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Columna created_by_staff (operaciones tomadas por el personal a nombre del cliente: no consumen su cupo)
-- ---------------------------------------------------------------------------------------------------------------------

ALTER TABLE public.reservations    ADD COLUMN IF NOT EXISTS created_by_staff boolean NOT NULL DEFAULT false;
ALTER TABLE public.takeaway_orders ADD COLUMN IF NOT EXISTS created_by_staff boolean NOT NULL DEFAULT false;

-- Las manuales que ya existen se reconocen por la marca que dejó el dashboard.
UPDATE public.reservations    SET created_by_staff = true
 WHERE NOT created_by_staff AND guest_data -> 0 ->> 'is_manual' = 'true';
UPDATE public.takeaway_orders SET created_by_staff = true
 WHERE NOT created_by_staff AND metadata ->> 'source' = 'dashboard-manual';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Conteo, verificación y lectura de uso
-- ---------------------------------------------------------------------------------------------------------------------

-- ¿El actor de un estado es del personal o del sistema? Sin actor, o actor de cliente, cuenta como del cliente.
CREATE OR REPLACE FUNCTION public.operation_is_staff_actor(p_role text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_role IS NOT NULL AND btrim(p_role) <> '' AND lower(p_role) NOT IN ('user', 'customer', 'guest', 'client');
$$;

-- ¿Intenta un cliente escribir en `timestamps` un estado con actor de personal/sistema (para que una cancelación no cuente)?
CREATE OR REPLACE FUNCTION public.operation_forged_actor(p_new jsonb, p_old jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(bool_or(
        jsonb_typeof(e.value) = 'object'
        AND public.operation_is_staff_actor(e.value ->> 'actor_role')
        AND e.value IS DISTINCT FROM (p_old -> e.key)
    ), false)
    FROM jsonb_each(CASE WHEN jsonb_typeof(p_new) = 'object' THEN p_new ELSE '{}'::jsonb END) e;
$$;

-- Ventanas de calendario en hora de Santiago.
CREATE OR REPLACE FUNCTION public.operation_windows(p_now timestamptz DEFAULT now())
RETURNS TABLE (day_start timestamptz, next_day timestamptz, week_start timestamptz, next_week timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT date_trunc('day',  p_now AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago',
           (date_trunc('day',  p_now AT TIME ZONE 'America/Santiago') + interval '1 day') AT TIME ZONE 'America/Santiago',
           date_trunc('week', p_now AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago',
           (date_trunc('week', p_now AT TIME ZONE 'America/Santiago') + interval '7 days') AT TIME ZONE 'America/Santiago';
$$;

CREATE OR REPLACE FUNCTION public.operation_counts(p_user uuid, p_now timestamptz DEFAULT now())
RETURNS TABLE (daily_used integer, weekly_used integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH w AS (SELECT * FROM public.operation_windows(p_now)),
    ops AS (
        SELECT r.created_at
          FROM public.reservations r
         WHERE r.organizer_id = p_user
           AND NOT r.created_by_staff
           AND r.status <> 'RECHAZADA'
           AND NOT (r.status = 'CANCELADA' AND public.operation_is_staff_actor(r.timestamps #>> '{CANCELADA,actor_role}'))
        UNION ALL
        SELECT o.created_at
          FROM public.takeaway_orders o
         WHERE o.user_id = p_user
           AND NOT o.created_by_staff
           AND o.status <> 'RECHAZADA'
           AND NOT (o.status = 'CANCELADO' AND public.operation_is_staff_actor(o.timestamps #>> '{CANCELADO,actor_role}'))
    )
    SELECT (count(*) FILTER (WHERE ops.created_at >= w.day_start AND ops.created_at < w.next_day))::integer,
           (count(*) FILTER (WHERE ops.created_at >= w.week_start AND ops.created_at < w.next_week))::integer
      FROM ops, w;
$$;

-- Devuelve NULL si el cliente puede operar; si no, {limit, limit_value, used, resets_at}. Toma un lock por usuario que dura
-- hasta el fin de la transacción: la inserción que sigue ve a las anteriores ya confirmadas.
CREATE OR REPLACE FUNCTION public.operation_limit_check(p_user uuid, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    cfg  public.operation_limits%ROWTYPE;
    c    record;
    w    record;
BEGIN
    IF p_user IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO cfg FROM public.operation_limits LIMIT 1;
    IF NOT FOUND OR NOT cfg.enabled THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user AND lower(p.account_type) = 'elite') THEN RETURN NULL; END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('operation_limits:' || p_user::text, 0));

    SELECT * INTO c FROM public.operation_counts(p_user, p_now);
    SELECT * INTO w FROM public.operation_windows(p_now);

    -- Si topan los dos, se informa el semanal (su cupo se libera más tarde).
    IF c.weekly_used >= cfg.weekly_limit THEN
        RETURN jsonb_build_object('limit', 'weekly', 'limit_value', cfg.weekly_limit, 'used', c.weekly_used, 'resets_at', w.next_week);
    ELSIF c.daily_used >= cfg.daily_limit THEN
        RETURN jsonb_build_object('limit', 'daily', 'limit_value', cfg.daily_limit, 'used', c.daily_used, 'resets_at', w.next_day);
    END IF;
    RETURN NULL;
END;
$$;

-- Uso para mostrar en la PWA (solo lectura, sin lock). Se llama desde el servidor con service_role.
CREATE OR REPLACE FUNCTION public.operation_usage(p_user uuid, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    cfg   public.operation_limits%ROWTYPE;
    c     record;
    w     record;
    elite boolean;
BEGIN
    SELECT * INTO cfg FROM public.operation_limits LIMIT 1;
    SELECT COALESCE(lower(p.account_type) = 'elite', false) INTO elite FROM public.profiles p WHERE p.id = p_user;
    elite := COALESCE(elite, false);
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
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Triggers (reservations y takeaway_orders)
--    · Un cliente (anon/authenticated) NO puede marcar una operación como del personal, ni fijar created_at, ni escribir en
--      `timestamps` estados con actor de personal/sistema. service_role y la base (sin claims) son de confianza.
--    · INSERT: si no es del personal, se verifica el límite.
-- ---------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reservations_operation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v jsonb;
BEGIN
    IF public.inventory_caller_role() IN ('anon', 'authenticated') THEN
        IF TG_OP = 'INSERT' THEN
            NEW.created_by_staff := false;
            NEW.created_at := now();
            IF public.operation_forged_actor(NEW.timestamps, NULL) THEN
                RAISE EXCEPTION 'timestamps con actor no permitido' USING ERRCODE = 'P0001', HINT = 'forbidden_actor';
            END IF;
        ELSE
            NEW.created_by_staff := OLD.created_by_staff;
            NEW.created_at := OLD.created_at;
            IF public.operation_forged_actor(NEW.timestamps, OLD.timestamps) THEN
                RAISE EXCEPTION 'timestamps con actor no permitido' USING ERRCODE = 'P0001', HINT = 'forbidden_actor';
            END IF;
        END IF;
    END IF;

    IF TG_OP = 'INSERT' AND NOT NEW.created_by_staff THEN
        v := public.operation_limit_check(NEW.organizer_id);
        IF v IS NOT NULL THEN
            RAISE EXCEPTION 'Llegaste a tu límite de operaciones'
                USING ERRCODE = 'P0001', HINT = 'limit_reached', DETAIL = v::text;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.takeaway_operation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v jsonb;
BEGIN
    IF public.inventory_caller_role() IN ('anon', 'authenticated') THEN
        IF TG_OP = 'INSERT' THEN
            NEW.created_by_staff := false;
            NEW.created_at := now();
            IF public.operation_forged_actor(NEW.timestamps, NULL) THEN
                RAISE EXCEPTION 'timestamps con actor no permitido' USING ERRCODE = 'P0001', HINT = 'forbidden_actor';
            END IF;
        ELSE
            NEW.created_by_staff := OLD.created_by_staff;
            NEW.created_at := OLD.created_at;
            IF public.operation_forged_actor(NEW.timestamps, OLD.timestamps) THEN
                RAISE EXCEPTION 'timestamps con actor no permitido' USING ERRCODE = 'P0001', HINT = 'forbidden_actor';
            END IF;
        END IF;
    END IF;

    IF TG_OP = 'INSERT' AND NOT NEW.created_by_staff THEN
        v := public.operation_limit_check(NEW.user_id);
        IF v IS NOT NULL THEN
            RAISE EXCEPTION 'Llegaste a tu límite de operaciones'
                USING ERRCODE = 'P0001', HINT = 'limit_reached', DETAIL = v::text;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.operation_is_staff_actor(text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operation_forged_actor(jsonb, jsonb)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operation_windows(timestamptz)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operation_counts(uuid, timestamptz)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operation_limit_check(uuid, timestamptz)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operation_usage(uuid, timestamptz)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reservations_operation_guard()               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.takeaway_operation_guard()                   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.operation_usage(uuid, timestamptz)        TO service_role;
GRANT EXECUTE ON FUNCTION public.operation_limit_check(uuid, timestamptz)  TO service_role;

-- reservations: antes de la autoaprobación (tr_auto_approve_reservation). takeaway_orders: después del guardia de plan
-- (tr_00_a_plan_guard) y antes del de stock (tr_00_inventory_guard).
DROP TRIGGER IF EXISTS tr_00_operation_guard ON public.reservations;
CREATE TRIGGER tr_00_operation_guard BEFORE INSERT OR UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.reservations_operation_guard();

DROP TRIGGER IF EXISTS tr_00_b_operation_guard ON public.takeaway_orders;
CREATE TRIGGER tr_00_b_operation_guard BEFORE INSERT OR UPDATE ON public.takeaway_orders
    FOR EACH ROW EXECUTE FUNCTION public.takeaway_operation_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. create_reservation_atomic: cuerpo REAL de producción (pg_get_functiondef, 2026-10-24) + límite + created_by_staff.
--    Respuesta de límite: {success:false, code:'limit_reached', limit, limit_value, used, resets_at} (mismo estilo que plan_blocked).
--    `created_by_staff` solo se respeta si viene en p_reservation_data; la PWA arma ese objeto en el servidor sin esa clave.
-- ---------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_reservation_atomic(p_restaurant_id uuid, p_organizer_id uuid, p_date_time timestamp with time zone, p_party_size integer, p_reservation_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_capacity integer; v_slot_duration integer; v_spaces_sum integer; v_blocked integer; v_booked integer; v_remaining integer; v_reservation_id uuid; v_unique_code text;
    v_by_staff boolean; v_limit jsonb;
BEGIN
    IF NOT public.restaurant_plan_allows(p_restaurant_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Este local no está recibiendo reservas por el momento', 'code', 'plan_blocked', 'plan_state', public.restaurant_effective_state(p_restaurant_id));
    END IF;
    v_by_staff := COALESCE((p_reservation_data->>'created_by_staff')::boolean, false);
    IF NOT v_by_staff THEN
        v_limit := public.operation_limit_check(p_organizer_id);
        IF v_limit IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'Llegaste a tu límite de operaciones', 'code', 'limit_reached') || v_limit;
        END IF;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('create_reservation_atomic:' || p_restaurant_id::text));
    SELECT COALESCE(slot_duration, 90), COALESCE((SELECT SUM((kv.value)::numeric)::integer FROM jsonb_each_text(r.space_capacities) kv), 0), capacity
    INTO v_slot_duration, v_spaces_sum, v_capacity FROM restaurants r WHERE r.id = p_restaurant_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Restaurante no encontrado'); END IF;
    IF v_spaces_sum > 0 THEN v_capacity := v_spaces_sum; ELSE v_capacity := COALESCE(NULLIF(v_capacity, 0), 50); END IF;
    SELECT COALESCE(SUM(blocked_slots), 0) INTO v_blocked FROM reservation_blocks
    WHERE restaurant_id = p_restaurant_id AND is_active AND start_time < p_date_time + make_interval(mins => v_slot_duration) AND end_time > p_date_time;
    SELECT COALESCE(SUM(party_size), 0) INTO v_booked FROM reservations
    WHERE restaurant_id = p_restaurant_id AND status IN ('PENDIENTE', 'CONFIRMADA', 'CHECK-IN CLIENTE', 'COMPLETADA')
      AND date_time < p_date_time + make_interval(mins => v_slot_duration)
      AND LEAST(date_time + make_interval(mins => v_slot_duration), COALESCE(NULLIF(metadata #>> '{table_released,at}', '')::timestamptz, 'infinity'::timestamptz)) > p_date_time;
    v_remaining := GREATEST(0, v_capacity - v_blocked) - v_booked;
    IF v_remaining < 1 OR v_remaining < p_party_size THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sin cupo disponible', 'remaining_seats', GREATEST(0, v_remaining));
    END IF;
    v_unique_code := p_reservation_data->>'unique_code';
    INSERT INTO reservations (restaurant_id, organizer_id, date_time, status, payment_method, title, guest_ids, guest_data, guests, party_size,
        organizer_reputation_snapshot, user_total_reservations_snapshot, discount_data_snapshot, applied_discount_id, account_type_snapshot,
        benefits_snapshot, validated_by_user, validated_by_restaurant, special_requests, unique_code, timestamps, created_by_staff)
    VALUES (p_restaurant_id, p_organizer_id, p_date_time, 'PENDIENTE', p_reservation_data->>'payment_method', p_reservation_data->>'title',
        ARRAY(SELECT jsonb_array_elements_text(p_reservation_data->'guest_ids')::uuid), p_reservation_data->'guest_data', p_reservation_data->'guests', p_party_size,
        (p_reservation_data->>'organizer_reputation_snapshot')::numeric, (p_reservation_data->>'user_total_reservations_snapshot')::integer,
        p_reservation_data->'discount_data_snapshot',
        CASE WHEN p_reservation_data->>'applied_discount_id' IS NOT NULL THEN (p_reservation_data->>'applied_discount_id')::uuid ELSE NULL END,
        p_reservation_data->>'account_type_snapshot', p_reservation_data->'benefits_snapshot', false, false,
        p_reservation_data->>'special_requests', v_unique_code, p_reservation_data->'timestamps', v_by_staff) RETURNING id INTO v_reservation_id;
    RETURN jsonb_build_object('success', true, 'id', v_reservation_id, 'unique_code', v_unique_code, 'remaining_seats', GREATEST(0, v_remaining - p_party_size));
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'Código duplicado, intenta de nuevo');
END;
$function$;
