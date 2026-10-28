-- Prueba de 033_availability_table_released.sql contra datos REALES de produccion (kqanordhsmbtcwtjtrme).
-- Un unico DO que termina en RAISE EXCEPTION: revierte todo (reservas de prueba y funciones). El resultado llega
-- como texto del error 'TEST_REPORT'. Bloque $m033$ = copia literal de la migracion. Se corre la misma bateria ANTES
-- de aplicarla (comportamiento actual) y DESPUES (esperado). Usa Zanzibar (capacidad 160, turno 90 min) en una fecha
-- lejana para no cruzarse con reservas reales.
--
-- RESULTADO (corrido contra produccion el 2026-10-06; todo revertido, 0 filas de prueba y funciones sin cambios):
--   ANTES : 1 false | 1b RPC t,160 (BUG: no contaba la completada) | 2 false | 2b RPC t,160 | 3 false | 4 false | 5 false | 5b true
--   DESPUES: 1 false | 1b RPC f,10 | 2 TRUE (liberada abre cupo) | 2b RPC t,160 | 3 false | 4 false | 5 false | 5b true
--   privilegios: anon=f authenticated=f service_role=t en ambas funciones.
DO $test$
DECLARE
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    t0 timestamptz := date_trunc('day', now() + interval '60 day') + interval '16 hour';
    a uuid; r jsonb; av record; rep text := '';
    data constant jsonb := '{"guest_ids":[],"guest_data":[],"guests":[],"payment_method":"individual","title":"t033","timestamps":{}}';
    phase text;
    n int := 0;

BEGIN
    -- Una completada de 150 personas a las t0 ocupa 150 de 160 cupos durante su turno (90 min).
    INSERT INTO public.reservations (restaurant_id, organizer_id, date_time, status, party_size, unique_code, organizer_reputation_snapshot)
      VALUES (rid, uB, t0, 'COMPLETADA', 150, 'T33A0001', 100) RETURNING id INTO a;

    FOREACH phase IN ARRAY ARRAY['ANTES de aplicar', 'DESPUES de aplicar'] LOOP
        IF phase = 'DESPUES de aplicar' THEN
            EXECUTE $m033$-- Migration 033: la disponibilidad respeta "Mesa liberada" del restaurant dashboard.
--
-- Regla de negocio (usuario, 2026-10-05): completar una reserva NO libera la mesa; sigue ocupada todo el turno
-- (slot_duration desde su hora) y el restaurante la libera antes con "Mesa liberada". El dashboard guarda ese
-- instante en reservations.metadata.table_released.at (v5-restaurant-dashboard#36, no toca timestamps).
-- Hasta hoy la disponibilidad contaba la completada todo su turno aunque ya estuviera liberada (lado conservador:
-- bloqueaba cupo, no sobrevendía). Esta migración hace que, liberada, la reserva solo ocupe hasta ese instante:
--   ocupa [date_time, LEAST(date_time + slot_duration, table_released.at))
-- y por tanto no cuenta para una reserva nueva cuya ventana empieza en o después de la liberación.
--
-- Funciones que cambian (CREATE OR REPLACE; cuerpo idéntico a producción salvo lo indicado, verificado 2026-10-06):
--   1) create_reservation_atomic: solo la consulta de v_booked (el solape usa LEAST(fin, liberación)).
--   2) check_restaurant_availability (la usa /api/availability de la PWA):
--      - mismo cambio de solape;
--      - CORRIGE el estado 'COMPLETADO' (no existe para reservas; el real es 'COMPLETADA') que dejaba a las
--        completadas fuera del conteo. Efecto: esta ruta pasa a contar las completadas todo su turno, como ya
--        hacía create_reservation_atomic y la pantalla de horarios; antes mostraba más cupo del que la
--        creación aceptaba.
-- Los privilegios no cambian: CREATE OR REPLACE los conserva (solo service_role); se reafirman.
-- No crea tablas, columnas ni funciones nuevas.
--
-- ORDEN DE DESPLIEGUE: aplicar esta migración PRIMERO. Mientras la capa de aplicación (reservation-slots.ts en
-- dashboard y PWA, y checkAdvancedAvailabilityAction del dashboard) no cambie, la pantalla de horarios sigue
-- contando la completada todo su turno y rechaza antes de llegar aquí: no hay cambio visible. Al desplegar el
-- código, la liberación empieza a abrir cupo. Al revés (código antes que migración) un cliente vería cupo y la
-- creación respondería "Sin cupo disponible".
--
-- VERIFICACION (después de aplicar):
--   select has_function_privilege('anon','public.create_reservation_atomic(uuid,uuid,timestamptz,integer,jsonb)','execute'),
--          has_function_privilege('authenticated','public.create_reservation_atomic(uuid,uuid,timestamptz,integer,jsonb)','execute'),
--          has_function_privilege('service_role','public.create_reservation_atomic(uuid,uuid,timestamptz,integer,jsonb)','execute');
--     -> false, false, true   (igual para check_restaurant_availability(uuid,timestamptz,integer))
--   select position('table_released' in pg_get_functiondef('public.create_reservation_atomic(uuid,uuid,timestamptz,integer,jsonb)'::regprocedure)) > 0;
--     -> true
-- ROLLBACK: volver a aplicar 025_create_reservation_atomic_same_rule.sql y la definición anterior de
--   check_restaurant_availability (ver el bloque ROLLBACK_CHECK al final de este archivo).

CREATE OR REPLACE FUNCTION public.create_reservation_atomic(
    p_restaurant_id uuid,
    p_organizer_id uuid,
    p_date_time timestamp with time zone,
    p_party_size integer,
    p_reservation_data jsonb
)
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

REVOKE ALL ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.check_restaurant_availability(
    p_restaurant_id uuid,
    p_selected_time timestamp with time zone,
    p_party_size integer
)
RETURNS TABLE(is_available boolean, remaining_seats integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_total_capacity integer;
    v_occupied_seats integer;
    v_slot_duration integer;
BEGIN
    -- Criterion 1.1: Sum of SILLAS inside space_capacities (Requires jsonb_each_text for PG sum)
    SELECT COALESCE(SUM((val)::int), 0), MAX(slot_duration) INTO v_total_capacity, v_slot_duration
    FROM public.restaurants r,
         LATERAL jsonb_each_text(r.space_capacities) AS kv(key, val)
    WHERE r.id = p_restaurant_id;

    -- Calculate occupied seats with SLOT_DURATION awareness (Rule 2)
    -- This handles overlaps: reservation starts before slot ends AND reservation ends after slot starts.
    -- 033: el estado correcto es 'COMPLETADA' (antes 'COMPLETADO', que no existe) y una completada con
    -- "Mesa liberada" termina en el instante de liberación (metadata.table_released.at).
    SELECT COALESCE(SUM(party_size), 0) INTO v_occupied_seats
    FROM public.reservations
    WHERE restaurant_id = p_restaurant_id
      AND status IN ('CONFIRMADA', 'PENDIENTE', 'CREADA', 'CHECK-IN CLIENTE', 'COMPLETADA')
      AND date_time < (p_selected_time + (v_slot_duration || ' minutes')::interval)
      AND LEAST(date_time + (v_slot_duration || ' minutes')::interval,
                COALESCE(NULLIF(metadata #>> '{table_released,at}', '')::timestamptz, 'infinity'::timestamptz)) > p_selected_time;

    RETURN QUERY
    SELECT
        ((v_total_capacity - v_occupied_seats) > 1 AND (v_total_capacity - v_occupied_seats) >= p_party_size) as is_available,
        (v_total_capacity - v_occupied_seats) as remaining_seats;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_restaurant_availability(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_restaurant_availability(uuid, timestamptz, integer) TO service_role;

-- ROLLBACK_CHECK: definición anterior de check_restaurant_availability (producción, 2026-10-06).
--   CREATE OR REPLACE FUNCTION public.check_restaurant_availability(p_restaurant_id uuid, p_selected_time timestamptz, p_party_size integer)
--   RETURNS TABLE(is_available boolean, remaining_seats integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
--   DECLARE v_total_capacity integer; v_occupied_seats integer; v_slot_duration integer;
--   BEGIN
--     SELECT COALESCE(SUM((val)::int), 0), MAX(slot_duration) INTO v_total_capacity, v_slot_duration
--       FROM public.restaurants r, LATERAL jsonb_each_text(r.space_capacities) AS kv(key, val) WHERE r.id = p_restaurant_id;
--     SELECT COALESCE(SUM(party_size), 0) INTO v_occupied_seats FROM public.reservations
--       WHERE restaurant_id = p_restaurant_id AND status IN ('CONFIRMADA','PENDIENTE','CREADA','CHECK-IN CLIENTE','COMPLETADO')
--         AND date_time < (p_selected_time + (v_slot_duration || ' minutes')::interval)
--         AND (date_time + (v_slot_duration || ' minutes')::interval) > p_selected_time;
--     RETURN QUERY SELECT ((v_total_capacity - v_occupied_seats) > 1 AND (v_total_capacity - v_occupied_seats) >= p_party_size),
--                         (v_total_capacity - v_occupied_seats);
--   END; $f$;
$m033$;
        END IF;
        rep := rep || '== ' || phase || E'\n';

        -- 1) completada sin liberar: 20 personas a las t0+30 no caben (quedan 10)
        UPDATE public.reservations SET metadata = NULL WHERE id = a;
        n := n + 1;
        r := public.create_reservation_atomic(rid, uB, t0 + interval '30 min', 20, data || jsonb_build_object('unique_code', 'T33N' || lpad(n::text, 4, '0')));
        rep := rep || format('1 sin liberar, 20 pax a t0+30: success=%s (esperado false)%s', r->>'success', E'\n');
        SELECT * INTO av FROM public.check_restaurant_availability(rid, t0 + interval '30 min', 20);
        rep := rep || format('1b disponibilidad RPC sin liberar: is_available=%s remaining=%s (esperado f,10 DESPUES; ANTES da t,160 por el estado COMPLETADO inexistente)%s', av.is_available, av.remaining_seats, E'\n');

        -- 2) liberada a las t0+10: una reserva que empieza en t0+30 ya no la cuenta
        UPDATE public.reservations SET metadata = jsonb_build_object('table_released', jsonb_build_object('at', (t0 + interval '10 min')::text)) WHERE id = a;
        n := n + 1;
        r := public.create_reservation_atomic(rid, uB, t0 + interval '30 min', 20, data || jsonb_build_object('unique_code', 'T33N' || lpad(n::text, 4, '0')));
        rep := rep || format('2 liberada a t0+10, 20 pax a t0+30: success=%s (esperado false ANTES, true DESPUES)%s', r->>'success', E'\n');
        DELETE FROM public.reservations WHERE unique_code = 'T33N' || lpad(n::text, 4, '0');
        SELECT * INTO av FROM public.check_restaurant_availability(rid, t0 + interval '30 min', 20);
        rep := rep || format('2b disponibilidad RPC liberada: is_available=%s remaining=%s (esperado f,10 ANTES; t,160 DESPUES)%s', av.is_available, av.remaining_seats, E'\n');

        -- 3) liberada a las t0+40: una reserva que empieza en t0+30 sigue chocando (la mesa estuvo ocupada hasta t0+40)
        UPDATE public.reservations SET metadata = jsonb_build_object('table_released', jsonb_build_object('at', (t0 + interval '40 min')::text)) WHERE id = a;
        n := n + 1;
        r := public.create_reservation_atomic(rid, uB, t0 + interval '30 min', 20, data || jsonb_build_object('unique_code', 'T33N' || lpad(n::text, 4, '0')));
        rep := rep || format('3 liberada a t0+40, 20 pax a t0+30: success=%s (esperado false)%s', r->>'success', E'\n');

        -- 4) una reserva que empieza ANTES de la liberacion (t0-60, su turno llega hasta t0+30) sigue contando la completada
        UPDATE public.reservations SET metadata = jsonb_build_object('table_released', jsonb_build_object('at', (t0 + interval '10 min')::text)) WHERE id = a;
        n := n + 1;
        r := public.create_reservation_atomic(rid, uB, t0 - interval '60 min', 20, data || jsonb_build_object('unique_code', 'T33N' || lpad(n::text, 4, '0')));
        rep := rep || format('4 liberada a t0+10, 20 pax a t0-60 (su turno la cruza): success=%s (esperado false)%s', r->>'success', E'\n');

        -- 5) sin metadata la regla anterior no cambia (turno completo)
        UPDATE public.reservations SET metadata = '{}'::jsonb WHERE id = a;
        n := n + 1;
        r := public.create_reservation_atomic(rid, uB, t0 + interval '89 min', 20, data || jsonb_build_object('unique_code', 'T33N' || lpad(n::text, 4, '0')));
        rep := rep || format('5 sin liberar, 20 pax a t0+89 (aun dentro del turno): success=%s (esperado false)%s', r->>'success', E'\n');
        n := n + 1;
        r := public.create_reservation_atomic(rid, uB, t0 + interval '90 min', 20, data || jsonb_build_object('unique_code', 'T33N' || lpad(n::text, 4, '0')));
        rep := rep || format('5b sin liberar, 20 pax a t0+90 (turno terminado): success=%s (esperado true)%s', r->>'success', E'\n');
        DELETE FROM public.reservations WHERE unique_code = 'T33N' || lpad(n::text, 4, '0');
    END LOOP;

    rep := rep || format('privilegios create anon=%s auth=%s service_role=%s (esperado f,f,t)%s',
        has_function_privilege('anon','public.create_reservation_atomic(uuid,uuid,timestamptz,integer,jsonb)','execute'),
        has_function_privilege('authenticated','public.create_reservation_atomic(uuid,uuid,timestamptz,integer,jsonb)','execute'),
        has_function_privilege('service_role','public.create_reservation_atomic(uuid,uuid,timestamptz,integer,jsonb)','execute'), E'\n');
    rep := rep || format('privilegios check anon=%s auth=%s service_role=%s (esperado f,f,t)%s',
        has_function_privilege('anon','public.check_restaurant_availability(uuid,timestamptz,integer)','execute'),
        has_function_privilege('authenticated','public.check_restaurant_availability(uuid,timestamptz,integer)','execute'),
        has_function_privilege('service_role','public.check_restaurant_availability(uuid,timestamptz,integer)','execute'), E'\n');

    RAISE EXCEPTION 'TEST_REPORT%', E'\n' || rep;
END
$test$;
