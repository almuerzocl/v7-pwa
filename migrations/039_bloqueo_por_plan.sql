-- Planes gobernados por Shopify, sección 7: bloqueo en la base según restaurant_operation_state().
--
-- NO aplicada todavía en producción: requiere confirmación (CLAUDE.md sección 6).
-- Los cuerpos de create_reservation_atomic, auto_approve_reservation y auto_approve_takeaway_order salen de
-- pg_get_functiondef contra producción (2026-10-11), no de los archivos de migración anteriores (pueden estar desactualizados).
--
-- INTERRUPTOR GLOBAL (decisión de implementación, no de la especificación): mientras `plan_enforcement.enabled` sea false, todo
-- local se comporta como `activo`. Así esta migración y el código que la usa se pueden desplegar ANTES de asignar períodos iniciales
-- a los locales existentes, sin dejarlos sin operar. Se activa con un solo UPDATE, después de sembrar los períodos:
--     UPDATE public.plan_enforcement SET enabled = true;
--
-- Qué bloquea (estado distinto de `activo`): crear reservas y pedidos nuevos (PWA y manuales), y aprobar pendientes, incluida la
-- autoaprobación. Lo ya confirmado sigue (check-in, preparar, entregar, cierre del día). El resto del bloqueo de `sin_vigencia`
-- (uso operativo del dashboard) es de la aplicación.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Interruptor global (una sola fila)
-- ---------------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plan_enforcement (
    singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    enabled    boolean     NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.plan_enforcement (singleton, enabled) VALUES (true, false) ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.plan_enforcement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_enforcement FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.plan_enforcement TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Estado efectivo (respeta el interruptor) y permiso de operar
-- ---------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.restaurant_effective_state(p_restaurant_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT CASE
        WHEN NOT COALESCE((SELECT e.enabled FROM public.plan_enforcement e LIMIT 1), false) THEN 'activo'
        ELSE public.restaurant_operation_state(p_restaurant_id)
    END;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_plan_allows(p_restaurant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.restaurant_effective_state(p_restaurant_id) = 'activo';
$$;

REVOKE ALL ON FUNCTION public.restaurant_effective_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restaurant_plan_allows(uuid)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_effective_state(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.restaurant_plan_allows(uuid)     TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Reservas: create_reservation_atomic (cubre la PWA y la reserva manual del dashboard)
-- ---------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_reservation_atomic(p_restaurant_id uuid, p_organizer_id uuid, p_date_time timestamp with time zone, p_party_size integer, p_reservation_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_capacity       integer;
    v_slot_duration  integer;
    v_spaces_sum     integer;
    v_blocked        integer;
    v_booked         integer;
    v_remaining      integer;
    v_reservation_id uuid;
    v_unique_code    text;
BEGIN
    -- Plan del local: con tope alcanzado o sin vigencia no se crean reservas nuevas.
    IF NOT public.restaurant_plan_allows(p_restaurant_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Este local no está recibiendo reservas por el momento',
                                  'code', 'plan_blocked', 'plan_state', public.restaurant_effective_state(p_restaurant_id));
    END IF;

    -- Serializa por restaurante (no por hora): las reservas se solapan a través de límites de hora y de día.
    PERFORM pg_advisory_xact_lock(hashtext('create_reservation_atomic:' || p_restaurant_id::text));

    SELECT COALESCE(slot_duration, 90),
           COALESCE((SELECT SUM((kv.value)::numeric)::integer FROM jsonb_each_text(r.space_capacities) kv), 0),
           capacity
    INTO v_slot_duration, v_spaces_sum, v_capacity
    FROM restaurants r WHERE r.id = p_restaurant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Restaurante no encontrado');
    END IF;

    -- Capacidad: suma de space_capacities, o capacity, o 50 (igual que computeDailySlots).
    IF v_spaces_sum > 0 THEN
        v_capacity := v_spaces_sum;
    ELSE
        v_capacity := COALESCE(NULLIF(v_capacity, 0), 50);
    END IF;

    -- Bloqueos activos que se solapan con [hora, hora + slot_duration).
    SELECT COALESCE(SUM(blocked_slots), 0) INTO v_blocked
    FROM reservation_blocks
    WHERE restaurant_id = p_restaurant_id
      AND is_active
      AND start_time < p_date_time + make_interval(mins => v_slot_duration)
      AND end_time   > p_date_time;

    -- Reservas que ocupan mesa y se solapan durante slot_duration. Una completada con "Mesa liberada" deja de
    -- ocupar desde ese instante (metadata.table_released.at): su fin es LEAST(hora + slot_duration, liberación).
    SELECT COALESCE(SUM(party_size), 0) INTO v_booked
    FROM reservations
    WHERE restaurant_id = p_restaurant_id
      AND status IN ('PENDIENTE', 'CONFIRMADA', 'CHECK-IN CLIENTE', 'COMPLETADA')
      AND date_time < p_date_time + make_interval(mins => v_slot_duration)
      AND LEAST(date_time + make_interval(mins => v_slot_duration),
                COALESCE(NULLIF(metadata #>> '{table_released,at}', '')::timestamptz, 'infinity'::timestamptz)) > p_date_time;

    v_remaining := GREATEST(0, v_capacity - v_blocked) - v_booked;

    IF v_remaining < 1 OR v_remaining < p_party_size THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sin cupo disponible',
                                  'remaining_seats', GREATEST(0, v_remaining));
    END IF;

    v_unique_code := p_reservation_data->>'unique_code';

    INSERT INTO reservations (
        restaurant_id, organizer_id, date_time, status, payment_method, title,
        guest_ids, guest_data, guests, party_size,
        organizer_reputation_snapshot, user_total_reservations_snapshot,
        discount_data_snapshot, applied_discount_id, account_type_snapshot,
        benefits_snapshot, validated_by_user, validated_by_restaurant,
        special_requests, unique_code, timestamps
    ) VALUES (
        p_restaurant_id, p_organizer_id, p_date_time, 'PENDIENTE',
        p_reservation_data->>'payment_method',
        p_reservation_data->>'title',
        ARRAY(SELECT jsonb_array_elements_text(p_reservation_data->'guest_ids')::uuid),
        p_reservation_data->'guest_data',
        p_reservation_data->'guests',
        p_party_size,
        (p_reservation_data->>'organizer_reputation_snapshot')::numeric,
        (p_reservation_data->>'user_total_reservations_snapshot')::integer,
        p_reservation_data->'discount_data_snapshot',
        CASE WHEN p_reservation_data->>'applied_discount_id' IS NOT NULL
             THEN (p_reservation_data->>'applied_discount_id')::uuid ELSE NULL END,
        p_reservation_data->>'account_type_snapshot',
        p_reservation_data->'benefits_snapshot',
        false, false,
        p_reservation_data->>'special_requests',
        v_unique_code,
        p_reservation_data->'timestamps'
    ) RETURNING id INTO v_reservation_id;

    RETURN jsonb_build_object('success', true, 'id', v_reservation_id,
                              'unique_code', v_unique_code,
                              'remaining_seats', GREATEST(0, v_remaining - p_party_size));
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'Código duplicado, intenta de nuevo');
END;
$function$;

-- Solo service_role (igual que antes: la 018 y la 029 lo dejaron así).
REVOKE ALL ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Autoaprobación: con el local bloqueado no se aprueba nada solo (defensa en profundidad: el INSERT ya se rechaza antes)
-- ---------------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_approve_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_settings jsonb;
    v_max_pax integer;
    v_min_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
    v_restaurant_name text;
BEGIN
    IF NEW.organizer_id IS NULL THEN
        RAISE EXCEPTION 'reservations: organizer_id es obligatorio (toda transaccion requiere identificacion)'
            USING ERRCODE = 'not_null_violation';
    END IF;

    SELECT takeaway_reputation, reservation_reputation
      INTO v_takeaway_reputation, v_reservation_reputation
      FROM public.profiles WHERE id = NEW.organizer_id;

    IF v_takeaway_reputation IS NULL OR v_reservation_reputation IS NULL
       OR v_takeaway_reputation NOT BETWEEN 0 AND 100
       OR v_reservation_reputation NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'reservations: el usuario % no tiene reputacion valida (0-100) en todos sus ambitos', NEW.organizer_id
            USING ERRCODE = 'check_violation';
    END IF;

    -- Plan del local sin cupo: la reserva queda PENDIENTE, no se aprueba sola.
    IF NOT public.restaurant_plan_allows(NEW.restaurant_id) THEN
        RETURN NEW;
    END IF;

    SELECT reservation_settings INTO v_settings
    FROM public.restaurants
    WHERE id = NEW.restaurant_id;

    IF v_settings IS NULL THEN
        RETURN NEW;
    END IF;

    v_max_pax := (v_settings->>'max_party_size')::integer;
    v_min_reputation := (v_settings->>'min_reputation')::integer;

    -- Sin parametros del restaurante no se aprueba automaticamente (queda PENDIENTE).
    IF v_max_pax IS NULL OR v_min_reputation IS NULL THEN
        RETURN NEW;
    END IF;

    -- Ambos criterios son concurrentes.
    IF NEW.status = 'PENDIENTE' AND
       NEW.party_size <= v_max_pax AND
       v_reservation_reputation >= v_min_reputation THEN

        NEW.status := 'CONFIRMADA';
        NEW.approved_at := now();
        NEW.confirmed_at := now();
        NEW.timestamps := COALESCE(NEW.timestamps, '{}'::jsonb) || jsonb_build_object(
            'CONFIRMADA', jsonb_build_object(
                'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'actor_id', NEW.organizer_id::text,
                'actor_role', 'system',
                'reason', format('Auto-aprobada: reputacion %s >= %s, grupo %s <= %s',
                                 v_reservation_reputation, v_min_reputation, NEW.party_size, v_max_pax)
            )
        );

        -- Notificacion in-app al cliente (mismo contenido que transition_status para CONFIRMADA).
        BEGIN
            SELECT name INTO v_restaurant_name FROM public.restaurants WHERE id = NEW.restaurant_id;
            INSERT INTO public.notifications (user_id, restaurant_id, type, title, message, related_id, priority, actor_id, actor_role)
            VALUES (NEW.organizer_id, NEW.restaurant_id, 'RESERVATION', COALESCE(v_restaurant_name, 'Restaurante'),
                    'Tu reserva ha sido confirmada', NEW.id, 'NORMAL', NEW.organizer_id, 'system');
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'auto_approve_reservation: no se pudo crear la notificacion (%): %', SQLSTATE, SQLERRM;
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
DECLARE
    v_settings jsonb;
    v_max_amount numeric;
    v_min_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
BEGIN
    IF NEW.user_id IS NULL THEN
        RAISE EXCEPTION 'takeaway_orders: user_id es obligatorio (toda transaccion requiere identificacion)'
            USING ERRCODE = 'not_null_violation';
    END IF;

    SELECT takeaway_reputation, reservation_reputation
      INTO v_takeaway_reputation, v_reservation_reputation
      FROM public.profiles WHERE id = NEW.user_id;

    IF v_takeaway_reputation IS NULL OR v_reservation_reputation IS NULL
       OR v_takeaway_reputation NOT BETWEEN 0 AND 100
       OR v_reservation_reputation NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'takeaway_orders: el usuario % no tiene reputacion valida (0-100) en todos sus ambitos', NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    -- Plan del local sin cupo: el pedido queda PENDIENTE, no se aprueba solo.
    IF NOT public.restaurant_plan_allows(NEW.restaurant_id) THEN
        RETURN NEW;
    END IF;

    SELECT takeaway_settings INTO v_settings FROM public.restaurants WHERE id = NEW.restaurant_id;
    IF v_settings IS NULL THEN RETURN NEW; END IF;

    v_max_amount := (v_settings->>'max_order_amount')::numeric;
    v_min_reputation := (v_settings->>'min_reputation')::integer;

    -- Sin parametros del restaurante no se aprueba automaticamente (queda PENDIENTE).
    IF v_max_amount IS NULL OR v_min_reputation IS NULL THEN RETURN NEW; END IF;

    -- Los dos criterios son concurrentes.
    IF (NEW.status IN ('PENDIENTE', 'CREADA'))
       AND NEW.total_amount <= v_max_amount
       AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Pedidos nuevos y aprobaciones manuales
-- ---------------------------------------------------------------------------------------------------------------------

-- Un pedido nuevo (PWA o manual del dashboard) no entra si el local no puede operar. Los triggers BEFORE INSERT disparan en orden
-- alfabético: `tr_00_a_plan_guard` va antes que `tr_00_inventory_guard` y que la autoaprobación, así se rechaza sin tocar stock.
CREATE OR REPLACE FUNCTION public.takeaway_plan_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.restaurant_plan_allows(NEW.restaurant_id) THEN
        RAISE EXCEPTION 'Este local no está recibiendo pedidos por el momento'
            USING ERRCODE = 'P0001', HINT = 'plan_blocked';
    END IF;
    RETURN NEW;
END;
$$;

-- Aprobar a mano un pendiente también se bloquea: una aprobación es una operación del plan.
CREATE OR REPLACE FUNCTION public.reservations_plan_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.status = 'CONFIRMADA' AND OLD.status IS DISTINCT FROM 'CONFIRMADA' AND OLD.status NOT IN ('CHECK-IN CLIENTE', 'COMPLETADA')
       AND NOT public.restaurant_plan_allows(NEW.restaurant_id) THEN
        RAISE EXCEPTION 'Este local alcanzó el tope de su plan: no puede confirmar reservas por el momento'
            USING ERRCODE = 'P0001', HINT = 'plan_blocked';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.takeaway_plan_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.status = 'APROBADA' AND OLD.status IN ('PENDIENTE', 'CREADA')
       AND NOT public.restaurant_plan_allows(NEW.restaurant_id) THEN
        RAISE EXCEPTION 'Este local alcanzó el tope de su plan: no puede aprobar pedidos por el momento'
            USING ERRCODE = 'P0001', HINT = 'plan_blocked';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.takeaway_plan_insert_guard()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reservations_plan_update_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.takeaway_plan_update_guard()    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_00_a_plan_guard ON public.takeaway_orders;
CREATE TRIGGER tr_00_a_plan_guard BEFORE INSERT ON public.takeaway_orders
    FOR EACH ROW EXECUTE FUNCTION public.takeaway_plan_insert_guard();

DROP TRIGGER IF EXISTS tr_plan_guard_update ON public.takeaway_orders;
CREATE TRIGGER tr_plan_guard_update BEFORE UPDATE ON public.takeaway_orders
    FOR EACH ROW EXECUTE FUNCTION public.takeaway_plan_update_guard();

DROP TRIGGER IF EXISTS tr_plan_guard_update ON public.reservations;
CREATE TRIGGER tr_plan_guard_update BEFORE UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.reservations_plan_update_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Visibilidad en el listado de la PWA: restaurants.plan_hidden
--    Caché de `restaurant_effective_state(id) <> 'activo'`. La verdad la sigue dando la función (los guardias de arriba no usan la
--    columna); la columna existe para que los listados puedan filtrar con PostgREST. Los interruptores del dueño no se tocan:
--    la visibilidad efectiva es el interruptor Y el estado.
-- ---------------------------------------------------------------------------------------------------------------------

ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS plan_hidden boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.refresh_plan_hidden(p_restaurant_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    UPDATE public.restaurants r
       SET plan_hidden = (public.restaurant_effective_state(r.id) <> 'activo')
     WHERE r.id = p_restaurant_id
       AND r.plan_hidden IS DISTINCT FROM (public.restaurant_effective_state(r.id) <> 'activo');
$$;

-- Recalcula todos: lo llama el job horario (el vencimiento por fecha no cambia ninguna fila por sí solo) y el interruptor global.
CREATE OR REPLACE FUNCTION public.refresh_plan_hidden_all()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE n integer;
BEGIN
    UPDATE public.restaurants r
       SET plan_hidden = (public.restaurant_effective_state(r.id) <> 'activo')
     WHERE r.plan_hidden IS DISTINCT FROM (public.restaurant_effective_state(r.id) <> 'activo');
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.plan_periods_refresh_hidden()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.refresh_plan_hidden(COALESCE(NEW.restaurant_id, OLD.restaurant_id));
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.plan_enforcement_refresh_hidden()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.refresh_plan_hidden_all();
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_plan_hidden(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_plan_hidden_all()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plan_periods_refresh_hidden()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plan_enforcement_refresh_hidden()    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_plan_hidden(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_plan_hidden_all() TO service_role;

DROP TRIGGER IF EXISTS tr_refresh_plan_hidden ON public.restaurant_plan_periods;
CREATE TRIGGER tr_refresh_plan_hidden AFTER INSERT OR UPDATE OR DELETE ON public.restaurant_plan_periods
    FOR EACH ROW EXECUTE FUNCTION public.plan_periods_refresh_hidden();

DROP TRIGGER IF EXISTS tr_refresh_plan_hidden ON public.plan_enforcement;
CREATE TRIGGER tr_refresh_plan_hidden AFTER UPDATE ON public.plan_enforcement
    FOR EACH STATEMENT EXECUTE FUNCTION public.plan_enforcement_refresh_hidden();

-- El listado de inicio (RPC) no incluye los locales ocultos por el plan.
CREATE OR REPLACE FUNCTION public.get_restaurants_with_discounts_today()
 RETURNS TABLE(restaurant_id uuid, institution_logos text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT ddc.restaurant_id,
        array_agg(DISTINCT ddc.institution_logo_url) FILTER (WHERE ddc.institution_logo_url IS NOT NULL)
    FROM public.daily_discount_cache ddc
    JOIN public.restaurants r ON r.id = ddc.restaurant_id AND NOT r.plan_hidden
    WHERE ddc.cache_date = CURRENT_DATE
    GROUP BY ddc.restaurant_id;
END;
$function$;
