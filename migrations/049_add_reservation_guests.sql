-- 049_add_reservation_guests.sql
-- Invitados agregados DESPUÉS de crear la reserva (solo el organizador, hasta la hora de la reserva).
--
-- Mismo camino que el wizard: el invitado entra a guest_data/guests con status PENDIENTE y su correo/teléfono;
-- el emisor de invitaciones (cron pwa-reservation-confirmations) envía la invitación personal solo a quien falta
-- (confirmation_sent) y solo con la reserva CONFIRMADA. Reglas fijadas por el usuario (2026-10-30):
--   * el cupo se valida igual que en create_reservation_atomic (el aumento debe caber);
--   * si el nuevo tamaño supera reservation_settings.max_party_size, la reserva vuelve a PENDIENTE (el organizador recibe un correo);
--   * si el restaurante RECHAZA ese aumento, la reserva vuelve a su tamaño anterior y a CONFIRMADA (no se pierde lo confirmado).
-- Quién puede llamarla: solo service_role (la acción de servidor valida la sesión y pasa p_actor_id).
--
-- Orden de despliegue: aplicar esta migración y luego desplegar la PWA (la acción llama al RPC).

CREATE OR REPLACE FUNCTION public.add_reservation_guests(p_reservation_id uuid, p_actor_id uuid, p_guests jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    r reservations%ROWTYPE;
    g jsonb;
    v_clean jsonb := '[]'::jsonb;
    v_contact_ids uuid[] := '{}';
    v_existing_ids text[];
    v_id text; v_name text; v_email text; v_phone text; v_user text;
    v_delta integer; v_new_size integer;
    v_capacity integer; v_slot_duration integer; v_spaces_sum integer; v_blocked integer; v_booked integer; v_remaining integer;
    v_settings jsonb; v_max_pax integer; v_needs_approval boolean := false;
    v_restaurant_name text;
BEGIN
    IF p_guests IS NULL OR jsonb_typeof(p_guests) <> 'array' OR jsonb_array_length(p_guests) NOT BETWEEN 1 AND 10 THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_guests', 'error', 'Indica entre 1 y 10 invitados');
    END IF;

    SELECT * INTO r FROM reservations WHERE id = p_reservation_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'not_found', 'error', 'Reserva no encontrada'); END IF;
    IF r.organizer_id IS DISTINCT FROM p_actor_id THEN
        RETURN jsonb_build_object('success', false, 'code', 'not_organizer', 'error', 'Solo el organizador puede agregar invitados');
    END IF;
    IF r.status NOT IN ('PENDIENTE', 'CONFIRMADA') THEN
        RETURN jsonb_build_object('success', false, 'code', 'not_editable', 'error', 'Esta reserva ya no admite nuevos invitados');
    END IF;
    IF r.date_time <= now() THEN
        RETURN jsonb_build_object('success', false, 'code', 'past', 'error', 'La hora de la reserva ya pasó');
    END IF;
    IF NOT public.restaurant_plan_allows(r.restaurant_id) THEN
        RETURN jsonb_build_object('success', false, 'code', 'plan_blocked', 'error', 'Este local no está recibiendo reservas por el momento');
    END IF;

    v_existing_ids := ARRAY(SELECT e->>'id' FROM jsonb_array_elements(COALESCE(r.guest_data, '[]'::jsonb)) e);

    FOR g IN SELECT * FROM jsonb_array_elements(p_guests) LOOP
        v_id := g->>'id';
        v_name := btrim(COALESCE(g->>'name', ''));
        v_email := NULLIF(btrim(COALESCE(g->>'email', '')), '');
        v_phone := NULLIF(btrim(COALESCE(g->>'phone', '')), '');
        v_user := g->>'user_id';
        IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR v_name = '' OR length(v_name) > 120 THEN
            RETURN jsonb_build_object('success', false, 'code', 'invalid_guests', 'error', 'Cada invitado necesita nombre e identificador válidos');
        END IF;
        IF v_id = ANY(v_existing_ids) THEN
            RETURN jsonb_build_object('success', false, 'code', 'duplicate_guest', 'error', 'Uno de los invitados ya está en la reserva');
        END IF;
        v_existing_ids := v_existing_ids || v_id;
        v_clean := v_clean || jsonb_build_object(
            'id', v_id, 'name', v_name, 'email', v_email, 'phone', v_phone,
            'is_organizer', false, 'status', 'PENDIENTE',
            'user_id', CASE WHEN v_user ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_user ELSE NULL END,
            'added_after_booking', true);
        v_contact_ids := v_contact_ids || v_id::uuid;
    END LOOP;

    v_delta := jsonb_array_length(v_clean);
    v_new_size := r.party_size + v_delta;

    -- Cupo: misma cuenta que create_reservation_atomic. La reserva ya cuenta con su tamaño actual, así que basta con que quepa el aumento.
    PERFORM pg_advisory_xact_lock(hashtext('create_reservation_atomic:' || r.restaurant_id::text));
    SELECT COALESCE(slot_duration, 90), COALESCE((SELECT SUM((kv.value)::numeric)::integer FROM jsonb_each_text(rt.space_capacities) kv), 0), rt.capacity, rt.name, rt.reservation_settings
      INTO v_slot_duration, v_spaces_sum, v_capacity, v_restaurant_name, v_settings
      FROM restaurants rt WHERE rt.id = r.restaurant_id;
    IF v_spaces_sum > 0 THEN v_capacity := v_spaces_sum; ELSE v_capacity := COALESCE(NULLIF(v_capacity, 0), 50); END IF;
    SELECT COALESCE(SUM(blocked_slots), 0) INTO v_blocked FROM reservation_blocks
     WHERE restaurant_id = r.restaurant_id AND is_active AND start_time < r.date_time + make_interval(mins => v_slot_duration) AND end_time > r.date_time;
    SELECT COALESCE(SUM(party_size), 0) INTO v_booked FROM reservations
     WHERE restaurant_id = r.restaurant_id AND status IN ('PENDIENTE', 'CONFIRMADA', 'CHECK-IN CLIENTE', 'COMPLETADA')
       AND date_time < r.date_time + make_interval(mins => v_slot_duration)
       AND LEAST(date_time + make_interval(mins => v_slot_duration), COALESCE(NULLIF(metadata #>> '{table_released,at}', '')::timestamptz, 'infinity'::timestamptz)) > r.date_time;
    v_remaining := GREATEST(0, v_capacity - v_blocked) - v_booked;
    IF v_remaining < v_delta THEN
        RETURN jsonb_build_object('success', false, 'code', 'no_capacity', 'error', 'Sin cupo disponible para sumar a esos invitados', 'remaining_seats', GREATEST(0, v_remaining));
    END IF;

    -- Misma regla de autoaprobación que auto_approve_reservation: grupo mayor que max_party_size => revisión del restaurante.
    v_max_pax := (v_settings->>'max_party_size')::integer;
    IF r.status = 'CONFIRMADA' AND v_max_pax IS NOT NULL AND v_new_size > v_max_pax THEN
        v_needs_approval := true;
    END IF;

    UPDATE reservations SET
        guest_data = COALESCE(guest_data, '[]'::jsonb) || v_clean,
        guests = COALESCE(guests, '[]'::jsonb) || v_clean,
        guest_ids = COALESCE(guest_ids, '{}') || v_contact_ids,
        party_size = v_new_size,
        -- Reabre el aviso: el emisor envía solo a quien falta (confirmation_sent) y solo con la reserva CONFIRMADA.
        confirmation_notified_at = NULL, confirmation_notify_attempts = 0, confirmation_notify_claimed_at = NULL,
        status = CASE WHEN v_needs_approval THEN 'PENDIENTE' ELSE status END,
        metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('guest_additions', COALESCE(metadata->'guest_additions', '[]'::jsonb)
                   || jsonb_build_array(jsonb_build_object('at', now(), 'count', v_delta, 'from', party_size, 'to', v_new_size, 'by', p_actor_id)))
            || CASE WHEN v_needs_approval AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'guest_addition_pending') THEN
                   jsonb_build_object('guest_addition_pending', jsonb_build_object(
                       'requested_at', now(), 'previous_party_size', r.party_size,
                       'previous_guest_data', COALESCE(r.guest_data, '[]'::jsonb), 'previous_guests', COALESCE(r.guests, '[]'::jsonb),
                       'previous_guest_ids', to_jsonb(COALESCE(r.guest_ids, '{}'))))
               ELSE '{}'::jsonb END
    WHERE id = r.id;

    IF v_needs_approval THEN
        BEGIN
            INSERT INTO notifications (user_id, restaurant_id, type, title, message, related_id, priority, actor_id, actor_role)
            SELECT p.id, r.restaurant_id, 'RESERVATION', COALESCE(v_restaurant_name, 'Restaurante'),
                   format('Aumento de reserva: de %s a %s personas, requiere tu aprobación', r.party_size, v_new_size),
                   r.id, 'CRITICAL', p_actor_id, 'customer'
              FROM profiles p WHERE p.restaurant_id = r.restaurant_id;
        EXCEPTION WHEN OTHERS THEN RAISE WARNING 'add_reservation_guests: no se pudo notificar al restaurante (%): %', SQLSTATE, SQLERRM;
        END;
    END IF;

    RETURN jsonb_build_object('success', true, 'id', r.id, 'unique_code', r.unique_code, 'party_size', v_new_size,
        'previous_party_size', r.party_size, 'needs_approval', v_needs_approval, 'status', CASE WHEN v_needs_approval THEN 'PENDIENTE' ELSE r.status END,
        'added_ids', (SELECT jsonb_agg(e->>'id') FROM jsonb_array_elements(v_clean) e));
END;
$function$;

REVOKE ALL ON FUNCTION public.add_reservation_guests(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_reservation_guests(uuid, uuid, jsonb) TO service_role;

-- Si el restaurante RECHAZA un aumento pendiente, la reserva vuelve a su tamaño anterior y a CONFIRMADA;
-- si lo APRUEBA, solo se limpia la marca. Corre al final (tr_zz) para que los demás guards vean el cambio original.
CREATE OR REPLACE FUNCTION public.reservations_guest_addition_resolve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE p jsonb;
BEGIN
    p := OLD.metadata -> 'guest_addition_pending';
    IF p IS NULL OR OLD.status IS DISTINCT FROM 'PENDIENTE' THEN RETURN NEW; END IF;

    IF NEW.status = 'RECHAZADA' THEN
        NEW.status := 'CONFIRMADA';
        NEW.party_size := (p->>'previous_party_size')::integer;
        NEW.guest_data := p->'previous_guest_data';
        NEW.guests := p->'previous_guests';
        NEW.guest_ids := ARRAY(SELECT jsonb_array_elements_text(p->'previous_guest_ids')::uuid);
        NEW.rejected_at := OLD.rejected_at;
        NEW.cancellation_reason := OLD.cancellation_reason;
        NEW.timestamps := OLD.timestamps;
        NEW.metadata := (COALESCE(NEW.metadata, '{}'::jsonb) - 'guest_addition_pending')
            || jsonb_build_object('guest_addition_declined', jsonb_build_object('at', now(), 'declined_party_size', OLD.party_size));
        BEGIN
            INSERT INTO public.notifications (user_id, restaurant_id, type, title, message, related_id, priority, actor_id, actor_role)
            VALUES (OLD.organizer_id, OLD.restaurant_id, 'RESERVATION',
                    COALESCE((SELECT name FROM public.restaurants WHERE id = OLD.restaurant_id), 'Restaurante'),
                    format('El restaurante no pudo aceptar el aumento a %s personas. Tu reserva se mantiene confirmada para %s.', OLD.party_size, (p->>'previous_party_size')),
                    OLD.id, 'HIGH', OLD.organizer_id, 'system');
        EXCEPTION WHEN OTHERS THEN RAISE WARNING 'reservations_guest_addition_resolve: no se pudo notificar (%): %', SQLSTATE, SQLERRM;
        END;
    ELSIF NEW.status = 'CONFIRMADA' THEN
        NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) - 'guest_addition_pending';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.reservations_guest_addition_resolve() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_zz_guest_addition_resolve ON public.reservations;
CREATE TRIGGER tr_zz_guest_addition_resolve BEFORE UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.reservations_guest_addition_resolve();
