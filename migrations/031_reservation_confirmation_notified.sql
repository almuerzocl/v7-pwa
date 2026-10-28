-- 031: correos de reserva SOLO al confirmarse -- marca de envio, intentos y reclamo atomico.
--
-- Regla de negocio (usuario, 2026-10-05): el correo de confirmacion (organizador) y las invitaciones
-- (invitados) salen UNA sola vez y solo cuando la reserva esta CONFIRMADA (autoaprobada, aprobada a mano o
-- creada por el restaurante). Una PENDIENTE, rechazada o cancelada antes de confirmarse no envia nada.
-- Emisor unico: PWA (src/lib/server/reservation-confirmation.ts), disparado por Cloud Scheduler cada minuto
-- y, para la autoaprobacion, en linea al crear. Esta migracion pone la infraestructura de idempotencia.
--
-- Columnas nuevas en reservations:
--   confirmation_notified_at       marca de "ya enviado" (NULL = pendiente de envio)
--   confirmation_notify_attempts   intentos hechos (tope 5 en el reclamo)
--   confirmation_notify_claimed_at reclamo con vencimiento de 5 min (recupera un proceso caido)
--   confirmation_sent              destinatarios ya atendidos ({"organizer":true,"g:<id>":true}), para que un
--                                  reintento solo repita los que faltan
-- BACKFILL: TODAS las reservas existentes (cualquier estado) quedan marcadas como notificadas, para que el
-- job nuevo no mande correos retroactivos.
-- claim_reservation_confirmations(): reclama filas CONFIRMADA sin marca, con fecha futura, < 5 intentos y sin
-- reclamo vigente, con FOR UPDATE SKIP LOCKED (dos ejecuciones simultaneas no reclaman la misma fila).
-- Solo service_role la ejecuta. No crea tablas (no aplica el GRANT de tablas nuevas); los GRANT de columnas
-- existentes de reservations no cambian.
-- Orden de despliegue: aplicar ANTES de desplegar la PWA con el emisor.
--
-- VERIFICACION (despues de aplicar):
--   select count(*) total, count(*) filter (where confirmation_notified_at is not null) marcadas from reservations;
--     -> marcadas = total (51 al 2026-10-05, mas las que existan al aplicar)
--   select has_function_privilege('anon','public.claim_reservation_confirmations(integer,uuid)','execute'),
--          has_function_privilege('authenticated','public.claim_reservation_confirmations(integer,uuid)','execute'),
--          has_function_privilege('service_role','public.claim_reservation_confirmations(integer,uuid)','execute');
--     -> false, false, true
-- ROLLBACK:
--   drop function if exists public.claim_reservation_confirmations(integer, uuid);
--   drop index if exists public.idx_reservations_confirmation_pending;
--   alter table public.reservations drop column if exists confirmation_notified_at,
--     drop column if exists confirmation_notify_attempts, drop column if exists confirmation_notify_claimed_at,
--     drop column if exists confirmation_sent;

ALTER TABLE public.reservations
    ADD COLUMN IF NOT EXISTS confirmation_notified_at timestamptz,
    ADD COLUMN IF NOT EXISTS confirmation_notify_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS confirmation_notify_claimed_at timestamptz,
    ADD COLUMN IF NOT EXISTS confirmation_sent jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.reservations
   SET confirmation_notified_at = now()
 WHERE confirmation_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_confirmation_pending
    ON public.reservations (date_time)
    WHERE status = 'CONFIRMADA' AND confirmation_notified_at IS NULL;

CREATE OR REPLACE FUNCTION public.claim_reservation_confirmations(p_limit integer DEFAULT 20, p_id uuid DEFAULT NULL)
 RETURNS SETOF public.reservations
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
    UPDATE public.reservations r
       SET confirmation_notify_claimed_at = now(),
           confirmation_notify_attempts = r.confirmation_notify_attempts + 1
     WHERE r.id IN (
        SELECT c.id
          FROM public.reservations c
         WHERE c.status = 'CONFIRMADA'
           AND c.confirmation_notified_at IS NULL
           AND c.date_time > now()
           AND c.confirmation_notify_attempts < 5
           AND (c.confirmation_notify_claimed_at IS NULL
                OR c.confirmation_notify_claimed_at < now() - interval '5 minutes')
           AND (p_id IS NULL OR c.id = p_id)
         ORDER BY c.date_time
         LIMIT GREATEST(p_limit, 1)
         FOR UPDATE SKIP LOCKED
     )
    RETURNING r.*;
$function$;

REVOKE ALL ON FUNCTION public.claim_reservation_confirmations(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reservation_confirmations(integer, uuid) TO service_role;
