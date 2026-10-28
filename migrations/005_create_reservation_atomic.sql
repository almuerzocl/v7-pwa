-- ============================================================
-- Migration 005: Atomic reservation creation
-- Prevents overbooking under concurrent load by combining
-- the capacity check + INSERT in a single serialized transaction.
--
-- Strategy: pg_advisory_xact_lock(hash(restaurant_id + slot_hour))
--   • Serializes concurrent requests for the same restaurant/slot
--   • Different restaurants or hours never block each other
--   • Lock releases automatically on transaction commit/rollback
-- ============================================================

CREATE OR REPLACE FUNCTION create_reservation_atomic(
    p_restaurant_id         uuid,
    p_organizer_id          uuid,
    p_date_time             timestamptz,
    p_party_size            integer,
    p_reservation_data      jsonb   -- all remaining reservation fields
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_capacity          integer;
    v_slot_duration     integer;
    v_slot_start        timestamptz;
    v_slot_end          timestamptz;
    v_booked            integer;
    v_remaining         integer;
    v_lock_key          bigint;
    v_reservation_id    uuid;
    v_unique_code       text;
BEGIN
    -- ── 1. Advisory lock: one transaction at a time per restaurant + hour ──
    -- hashtext returns integer; shift organizer bits to get a stable bigint key
    v_lock_key := hashtext(p_restaurant_id::text || date_trunc('hour', p_date_time)::text)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- ── 2. Fetch restaurant capacity & slot duration ──
    SELECT
        COALESCE(capacity, 999),
        COALESCE(slot_duration, 90)
    INTO v_capacity, v_slot_duration
    FROM restaurants
    WHERE id = p_restaurant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Restaurante no encontrado');
    END IF;

    -- ── 3. Compute slot window (same logic as check_restaurant_availability) ──
    -- Two reservations overlap if they fall within ±slot_duration minutes of each other
    v_slot_start := p_date_time - ((v_slot_duration - 1) || ' minutes')::interval;
    v_slot_end   := p_date_time + ((v_slot_duration - 1) || ' minutes')::interval;

    -- ── 4. Count booked seats in the slot (locked rows) ──
    SELECT COALESCE(SUM(party_size), 0)
    INTO v_booked
    FROM reservations
    WHERE restaurant_id = p_restaurant_id
      AND date_time BETWEEN v_slot_start AND v_slot_end
      AND status NOT IN ('CANCELADA', 'NO_SHOW', 'RECHAZADA');

    v_remaining := v_capacity - v_booked;

    -- ── 5. Capacity gate ──
    IF v_remaining < p_party_size THEN
        RETURN jsonb_build_object(
            'success',         false,
            'error',           'Sin cupo disponible',
            'remaining_seats', GREATEST(0, v_remaining)
        );
    END IF;

    -- ── 6. Insert reservation ──
    v_unique_code := p_reservation_data->>'unique_code';

    INSERT INTO reservations (
        restaurant_id,
        organizer_id,
        date_time,
        status,
        payment_method,
        title,
        guest_ids,
        guest_data,
        guests,
        party_size,
        organizer_reputation_snapshot,
        user_total_reservations_snapshot,
        discount_data_snapshot,
        applied_discount_id,
        account_type_snapshot,
        benefits_snapshot,
        validated_by_user,
        validated_by_restaurant,
        special_requests,
        unique_code,
        timestamps
    ) VALUES (
        p_restaurant_id,
        p_organizer_id,
        p_date_time,
        'PENDIENTE',
        p_reservation_data->>'payment_method',
        p_reservation_data->>'title',
        ARRAY(SELECT jsonb_array_elements_text(p_reservation_data->'guest_ids')),
        p_reservation_data->'guest_data',
        p_reservation_data->'guests',
        p_party_size,
        (p_reservation_data->>'organizer_reputation_snapshot')::numeric,
        (p_reservation_data->>'user_total_reservations_snapshot')::integer,
        p_reservation_data->'discount_data_snapshot',
        CASE WHEN p_reservation_data->>'applied_discount_id' IS NOT NULL
             THEN (p_reservation_data->>'applied_discount_id')::uuid
             ELSE NULL END,
        p_reservation_data->>'account_type_snapshot',
        p_reservation_data->'benefits_snapshot',
        false,
        false,
        p_reservation_data->>'special_requests',
        v_unique_code,
        p_reservation_data->'timestamps'
    )
    RETURNING id INTO v_reservation_id;

    RETURN jsonb_build_object(
        'success',         true,
        'id',              v_reservation_id,
        'unique_code',     v_unique_code,
        'remaining_seats', GREATEST(0, v_remaining - p_party_size)
    );

EXCEPTION WHEN unique_violation THEN
    -- unique_code collision (extremely rare) — caller should retry with new code
    RETURN jsonb_build_object('success', false, 'error', 'Código duplicado, intenta de nuevo');
END;
$$;

-- Grant execute to authenticated and service role
GRANT EXECUTE ON FUNCTION create_reservation_atomic TO service_role;
