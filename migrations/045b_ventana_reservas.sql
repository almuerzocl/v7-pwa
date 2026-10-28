-- 045b: ventana de reservas (esquema). Especificación: ESPECIFICACION_VENTANA_RESERVAS.md, secciones 4, 5 y 7.
-- Requiere 045a (opening_hours en forma canónica). Con el interruptor APAGADO (default) NADA cambia de comportamiento:
-- la regla solo permite. Orden de despliegue: esta migración -> código (PWA y dashboard) -> UPDATE del interruptor.
--
-- Qué crea:
--   1. restaurants.reservation_hours jsonb NULL   (NULL = sin ventana propia: la ventana es el horario de atención)
--   2. reservation_window_enforcement             (interruptor global; mismo patrón que plan_enforcement / operation_limits)
--   3. _hours_day_shifts / reservation_slot_rule / reservation_slot_allowed   (regla única, zona America/Santiago)
--   4. trigger de coherencia en restaurants       (forma y contención de reservation_hours en opening_hours)
--   5. create_reservation_atomic                  (rechaza con code 'outside_reservation_window'; orden plan -> ventana -> límite -> cupo)
--   6. trigger BEFORE INSERT en reservations      (anon/authenticated no pueden insertar fuera de ventana; cierra el INSERT directo)
--
-- Regla: un instante es un INICIO válido si, en hora de Santiago, cae en un turno efectivo del día (propio o de madrugada del
-- día anterior, para turnos que cruzan la medianoche), es decir ventana ∩ atención, y está alineado a la grilla de
-- slot_interval_minutes contada desde la apertura del turno de la ventana (o de la atención si reservation_hours es NULL).
-- Solo el inicio debe caber (D1). No revisa hora pasada ni cupo. Un turno con cierre <= apertura cruza la medianoche.
--
-- GRANT explícito (CLAUDE.md sección 6): funciones solo para service_role; tabla nueva solo SELECT/UPDATE a service_role.

-- 1. Columna ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS reservation_hours jsonb;
COMMENT ON COLUMN public.restaurants.reservation_hours IS
  'Ventana de reservas en la misma forma canónica que opening_hours. NULL = la ventana es el horario de atención. Se intersecta con opening_hours al leer.';

-- 2. Interruptor global ----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reservation_window_enforcement (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.reservation_window_enforcement (singleton, enabled) VALUES (true, false) ON CONFLICT (singleton) DO NOTHING;
ALTER TABLE public.reservation_window_enforcement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reservation_window_enforcement FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE ON public.reservation_window_enforcement TO service_role;

-- 3. Regla única -----------------------------------------------------------------------------------------------------
-- Turnos de un día en minutos desde las 00:00 del día de apertura; un cierre <= apertura suma 1440 (cruza la medianoche).
-- Lee solo la forma canónica (claves largas) y tolera el valor objeto en vez de arreglo; ignora turnos cerrados o mal formados.
CREATE OR REPLACE FUNCTION public._hours_day_shifts(p_hours jsonb, p_dow integer)
RETURNS TABLE (s integer, e integer)
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  WITH d AS (
    SELECT CASE jsonb_typeof(v) WHEN 'array' THEN v WHEN 'object' THEN jsonb_build_array(v) ELSE '[]'::jsonb END AS arr
    FROM (SELECT p_hours -> (ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[p_dow + 1] AS v) q
  ), t AS (
    SELECT x ->> 'open' AS o, x ->> 'close' AS c
    FROM d, jsonb_array_elements(d.arr) x
    WHERE jsonb_typeof(x) = 'object'
      AND COALESCE(x ->> 'is_closed', 'false') <> 'true'
      AND x ->> 'open'  ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND x ->> 'close' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ), m AS (
    SELECT split_part(o, ':', 1)::int * 60 + split_part(o, ':', 2)::int AS os,
           split_part(c, ':', 1)::int * 60 + split_part(c, ':', 2)::int AS cs
    FROM t
  )
  SELECT os, CASE WHEN cs <= os THEN cs + 1440 ELSE cs END FROM m;
$$;

-- Regla pura (ignora el interruptor). NULL si el restaurante no existe.
CREATE OR REPLACE FUNCTION public.reservation_slot_rule(p_restaurant_id uuid, p_date_time timestamptz)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_local timestamp;
  v_step integer;
  v_day date;
  v_off integer;
  v_dow integer;
  w record;
  k integer;
BEGIN
  SELECT opening_hours, reservation_hours, slot_interval_minutes INTO r FROM public.restaurants WHERE id = p_restaurant_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_step := CASE WHEN r.slot_interval_minutes IN (10, 15, 30, 60) THEN r.slot_interval_minutes ELSE 30 END;
  v_local := p_date_time AT TIME ZONE 'America/Santiago';
  IF date_trunc('minute', v_local) <> v_local THEN RETURN false; END IF;
  FOR k IN 0..1 LOOP
    v_day := v_local::date - k;
    v_off := (extract(epoch FROM (v_local - v_day::timestamp)) / 60)::integer;
    v_dow := extract(dow FROM v_day)::integer;
    FOR w IN
      SELECT GREATEST(o.s, rr.s) AS lo, LEAST(o.e, rr.e) AS hi, rr.s AS origin
      FROM public._hours_day_shifts(r.opening_hours, v_dow) o
      JOIN LATERAL (
        SELECT h.s, h.e FROM public._hours_day_shifts(r.reservation_hours, v_dow) h WHERE r.reservation_hours IS NOT NULL
        UNION ALL
        SELECT o.s, o.e WHERE r.reservation_hours IS NULL
      ) rr ON true
    LOOP
      IF w.lo < w.hi AND v_off >= w.lo AND v_off < w.hi AND (v_off - w.origin) % v_step = 0 THEN
        RETURN true;
      END IF;
    END LOOP;
  END LOOP;
  RETURN false;
END;
$$;

-- Regla con interruptor: apagado => siempre permite; restaurante inexistente => permite (lo resuelve quien llama).
CREATE OR REPLACE FUNCTION public.reservation_slot_allowed(p_restaurant_id uuid, p_date_time timestamptz)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN NOT COALESCE((SELECT enabled FROM public.reservation_window_enforcement LIMIT 1), false) THEN true
    ELSE COALESCE(public.reservation_slot_rule(p_restaurant_id, p_date_time), true)
  END;
$$;

REVOKE ALL ON FUNCTION public._hours_day_shifts(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reservation_slot_rule(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reservation_slot_allowed(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._hours_day_shifts(jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reservation_slot_rule(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.reservation_slot_allowed(uuid, timestamptz) TO service_role;

-- 4. Coherencia de reservation_hours (red de seguridad; la validación principal vive en el servidor) ----------------------
-- Forma: objeto con claves largas; cada día arreglo de <= 4 turnos {open,close} HH:mm (open <> close) o un único {is_closed:true}.
-- Contención: cada turno de la ventana cabe dentro de un turno de opening_hours del mismo día. NO bloquea cambios de
-- opening_hours: la ventana efectiva (intersección al leer) se recorta sola.
CREATE OR REPLACE FUNCTION public.restaurants_reservation_hours_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  kv record;
  el jsonb;
  d integer;
  w record;
  names text[] := ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  re text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
BEGIN
  IF NEW.reservation_hours IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.reservation_hours) <> 'object' THEN
    RAISE EXCEPTION 'reservation_hours debe ser un objeto' USING ERRCODE = 'check_violation';
  END IF;
  FOR kv IN SELECT key, value FROM jsonb_each(NEW.reservation_hours) LOOP
    IF NOT (kv.key = ANY (names)) THEN
      RAISE EXCEPTION 'reservation_hours: día no válido "%"', kv.key USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(kv.value) <> 'array' OR jsonb_array_length(kv.value) > 4 THEN
      RAISE EXCEPTION 'reservation_hours.%: debe ser un arreglo de hasta 4 turnos', kv.key USING ERRCODE = 'check_violation';
    END IF;
    FOR el IN SELECT * FROM jsonb_array_elements(kv.value) LOOP
      IF jsonb_typeof(el) <> 'object' THEN
        RAISE EXCEPTION 'reservation_hours.%: turno no válido', kv.key USING ERRCODE = 'check_violation';
      ELSIF el = '{"is_closed": true}'::jsonb THEN
        IF jsonb_array_length(kv.value) <> 1 THEN
          RAISE EXCEPTION 'reservation_hours.%: un día cerrado no lleva otros turnos', kv.key USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NOT (
        (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(el) k) = ARRAY['close','open']
        AND el ->> 'open' ~ re AND el ->> 'close' ~ re AND el ->> 'open' <> el ->> 'close'
      ) THEN
        RAISE EXCEPTION 'reservation_hours.%: turno con formato no válido', kv.key USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;
  FOR d IN 0..6 LOOP
    FOR w IN SELECT s, e FROM public._hours_day_shifts(NEW.reservation_hours, d) LOOP
      IF NOT EXISTS (SELECT 1 FROM public._hours_day_shifts(NEW.opening_hours, d) o WHERE o.s <= w.s AND w.e <= o.e) THEN
        RAISE EXCEPTION 'reservation_hours.%: un turno queda fuera del horario de atención', names[d + 1] USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.restaurants_reservation_hours_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurants_reservation_hours_guard() TO service_role;

DROP TRIGGER IF EXISTS tr_restaurants_reservation_hours_guard ON public.restaurants;
CREATE TRIGGER tr_restaurants_reservation_hours_guard
  BEFORE INSERT OR UPDATE OF reservation_hours ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION public.restaurants_reservation_hours_guard();

-- 5. create_reservation_atomic: cuerpo REAL de producción (2026-10-26) + chequeo de ventana tras el plan y antes del límite --
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
    IF NOT public.reservation_slot_allowed(p_restaurant_id, p_date_time) THEN
        RETURN jsonb_build_object('success', false, 'error', 'A esa hora el local está abierto pero no recibe reservas', 'code', 'outside_reservation_window');
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
REVOKE ALL ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) TO service_role;

-- 6. INSERT directo de un cliente (anon/authenticated) fuera de ventana ---------------------------------------------------
-- El RPC corre como SECURITY DEFINER y la reserva del personal también entra por él (rol service_role): no se les aplica aquí.
CREATE OR REPLACE FUNCTION public.reservations_window_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF public.inventory_caller_role() IN ('anon', 'authenticated')
     AND NOT public.reservation_slot_allowed(NEW.restaurant_id, NEW.date_time) THEN
    RAISE EXCEPTION 'A esa hora el local no recibe reservas'
      USING ERRCODE = 'P0001', HINT = 'outside_reservation_window';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reservations_window_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reservations_window_guard() TO service_role;

DROP TRIGGER IF EXISTS tr_00_c_reservation_window_guard ON public.reservations;
CREATE TRIGGER tr_00_c_reservation_window_guard
  BEFORE INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.reservations_window_guard();
