-- 050_guest_addition_declined_notice.sql
-- Correo al organizador cuando el restaurante RECHAZA el aumento de personas de una reserva confirmada (049).
-- Hasta ahora solo recibía un aviso dentro de la app. Mismo patrón que el resto de los avisos: reclamo atómico
-- (FOR UPDATE SKIP LOCKED, tope de 5 intentos, reclamo vence a los 5 min) y marca de enviado; el envío lo hace
-- la PWA en el cron pwa-reservation-confirmations. Todo vive en reservations.metadata.guest_addition_declined.
-- Orden: aplicar esta migración y luego desplegar la PWA (el cron llama a las funciones nuevas).

-- 1) El trigger de 049 ahora deja también los nombres de los invitados que se quitaron.
CREATE OR REPLACE FUNCTION public.reservations_guest_addition_resolve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE p jsonb; v_removed jsonb;
BEGIN
    p := OLD.metadata -> 'guest_addition_pending';
    IF p IS NULL OR OLD.status IS DISTINCT FROM 'PENDIENTE' THEN RETURN NEW; END IF;

    IF NEW.status = 'RECHAZADA' THEN
        v_removed := (SELECT COALESCE(jsonb_agg(e->>'name'), '[]'::jsonb)
                        FROM jsonb_array_elements(COALESCE(OLD.guest_data, '[]'::jsonb)) e
                       WHERE NOT ((e->>'id') = ANY(ARRAY(SELECT x->>'id' FROM jsonb_array_elements(COALESCE(p->'previous_guest_data', '[]'::jsonb)) x))));
        NEW.status := 'CONFIRMADA';
        NEW.party_size := (p->>'previous_party_size')::integer;
        NEW.guest_data := p->'previous_guest_data';
        NEW.guests := p->'previous_guests';
        NEW.guest_ids := ARRAY(SELECT jsonb_array_elements_text(p->'previous_guest_ids')::uuid);
        NEW.rejected_at := OLD.rejected_at;
        NEW.cancellation_reason := OLD.cancellation_reason;
        NEW.timestamps := OLD.timestamps;
        NEW.metadata := (COALESCE(NEW.metadata, '{}'::jsonb) - 'guest_addition_pending')
            || jsonb_build_object('guest_addition_declined', jsonb_build_object(
                   'at', now(), 'declined_party_size', OLD.party_size, 'previous_party_size', (p->>'previous_party_size')::integer, 'removed_guests', v_removed));
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

-- 2) Reclamo atómico de los avisos pendientes (solo reservas futuras y confirmadas).
CREATE OR REPLACE FUNCTION public.claim_guest_addition_declines(p_limit integer DEFAULT 20, p_id uuid DEFAULT NULL)
RETURNS SETOF public.reservations
LANGUAGE sql
SET search_path TO 'public'
AS $function$
    UPDATE public.reservations r
       SET metadata = r.metadata || jsonb_build_object('guest_addition_declined',
               (r.metadata->'guest_addition_declined') || jsonb_build_object(
                   'notify_claimed_at', now(),
                   'attempts', COALESCE((r.metadata #>> '{guest_addition_declined,attempts}')::integer, 0) + 1))
     WHERE r.id IN (
        SELECT c.id
          FROM public.reservations c
         WHERE c.metadata ? 'guest_addition_declined'
           AND c.metadata #>> '{guest_addition_declined,notified_at}' IS NULL
           AND c.status = 'CONFIRMADA'
           AND c.date_time > now()
           AND COALESCE((c.metadata #>> '{guest_addition_declined,attempts}')::integer, 0) < 5
           AND (c.metadata #>> '{guest_addition_declined,notify_claimed_at}' IS NULL
                OR (c.metadata #>> '{guest_addition_declined,notify_claimed_at}')::timestamptz < now() - interval '5 minutes')
           AND (p_id IS NULL OR c.id = p_id)
         ORDER BY c.date_time
         LIMIT GREATEST(p_limit, 1)
         FOR UPDATE SKIP LOCKED
     )
    RETURNING r.*;
$function$;

-- 3) Marca de enviado.
CREATE OR REPLACE FUNCTION public.mark_guest_addition_decline_notified(p_id uuid)
RETURNS void
LANGUAGE sql
SET search_path TO 'public'
AS $function$
    UPDATE public.reservations
       SET metadata = jsonb_set(metadata, '{guest_addition_declined,notified_at}', to_jsonb(now()))
     WHERE id = p_id AND metadata ? 'guest_addition_declined';
$function$;

REVOKE ALL ON FUNCTION public.claim_guest_addition_declines(integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_guest_addition_decline_notified(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_guest_addition_declines(integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_guest_addition_decline_notified(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.reservations_guest_addition_resolve() FROM PUBLIC, anon, authenticated;
