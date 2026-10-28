-- ============================================================
-- Migration 025: create_reservation_atomic usa LA MISMA regla de cupo que la pantalla de disponibilidad.
--
-- Antes (005, igual en producción — verificado 2026-10-03) la función decidía el cupo con otra regla:
--   * capacidad = capacity o 999 (la pantalla: suma de space_capacities, o capacity, o 50)
--   * ignoraba reservation_blocks (la pantalla los descuenta)
--   * ventana ±(slot_duration-1) alrededor de la hora pedida (la pantalla: solapamiento de intervalos)
--   * contaba todo estado salvo CANCELADA/NO_SHOW/RECHAZADA (la pantalla: PENDIENTE, CONFIRMADA,
--     CHECK-IN CLIENTE, COMPLETADA)
--   * lock por restaurante + HORA: dos reservas que se solapan en horas distintas (19:45 y 20:15) no se
--     serializaban y podían sobrevender.
-- Fuente de verdad: src/lib/core-business/reservation-slots.ts (computeDailySlots / loadDayInputs).
--
-- El horario (restaurante activo, día y turno abiertos, grilla de 30 min, hora futura) lo valida la capa de
-- aplicación (validateReservationSlot) antes de llamar a esta función; aquí solo el cupo, que es lo que
-- compite entre transacciones. El resto del cuerpo (INSERT, retorno) es idéntico a producción.
-- ============================================================
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

    -- Reservas que ocupan mesa y se solapan durante slot_duration.
    SELECT COALESCE(SUM(party_size), 0) INTO v_booked
    FROM reservations
    WHERE restaurant_id = p_restaurant_id
      AND status IN ('PENDIENTE', 'CONFIRMADA', 'CHECK-IN CLIENTE', 'COMPLETADA')
      AND date_time < p_date_time + make_interval(mins => v_slot_duration)
      AND date_time + make_interval(mins => v_slot_duration) > p_date_time;

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

-- CREATE OR REPLACE conserva los GRANT/REVOKE de 016 (solo service_role); se reafirma por claridad.
REVOKE ALL ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) TO service_role;
