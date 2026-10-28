-- 032: aviso de RECHAZO de una reserva, solo al organizador (complementa 031).
--
-- Regla de negocio (usuario, 2026-10-06): cuando el restaurante RECHAZA una reserva se informa SOLO al organizador
-- (nunca a los invitados). Una reserva PENDIENTE no envia nada. Se envia una sola vez y solo si la hora de la
-- reserva aun no pasó. Mismo emisor que 031 (PWA, src/lib/server/reservation-confirmation.ts) y mismo cron.
--
-- Columnas nuevas en reservations: rejection_notified_at (marca de enviado), rejection_notify_attempts (tope 5),
-- rejection_notify_claimed_at (reclamo con vencimiento de 5 min).
-- BACKFILL: TODAS las reservas existentes quedan marcadas (no se avisan rechazos antiguos).
-- claim_reservation_rejections(): reclama filas RECHAZADA sin marca, con fecha futura, < 5 intentos y sin reclamo
-- vigente (FOR UPDATE SKIP LOCKED). Solo service_role la ejecuta. No crea tablas.
-- Orden de despliegue: aplicar ANTES de desplegar la PWA con el aviso de rechazo.
--
-- VERIFICACION:
--   select count(*) total, count(*) filter (where rejection_notified_at is not null) marcadas from reservations;
--     -> marcadas = total
--   select has_function_privilege('anon','public.claim_reservation_rejections(integer,uuid)','execute'),
--          has_function_privilege('authenticated','public.claim_reservation_rejections(integer,uuid)','execute'),
--          has_function_privilege('service_role','public.claim_reservation_rejections(integer,uuid)','execute');
--     -> false, false, true
-- ROLLBACK:
--   drop function if exists public.claim_reservation_rejections(integer, uuid);
--   drop index if exists public.idx_reservations_rejection_pending;
--   alter table public.reservations drop column if exists rejection_notified_at,
--     drop column if exists rejection_notify_attempts, drop column if exists rejection_notify_claimed_at;

ALTER TABLE public.reservations
    ADD COLUMN IF NOT EXISTS rejection_notified_at timestamptz,
    ADD COLUMN IF NOT EXISTS rejection_notify_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rejection_notify_claimed_at timestamptz;

UPDATE public.reservations
   SET rejection_notified_at = now()
 WHERE rejection_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_rejection_pending
    ON public.reservations (date_time)
    WHERE status = 'RECHAZADA' AND rejection_notified_at IS NULL;

CREATE OR REPLACE FUNCTION public.claim_reservation_rejections(p_limit integer DEFAULT 20, p_id uuid DEFAULT NULL)
 RETURNS SETOF public.reservations
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
    UPDATE public.reservations r
       SET rejection_notify_claimed_at = now(),
           rejection_notify_attempts = r.rejection_notify_attempts + 1
     WHERE r.id IN (
        SELECT c.id
          FROM public.reservations c
         WHERE c.status = 'RECHAZADA'
           AND c.rejection_notified_at IS NULL
           AND c.date_time > now()
           AND c.rejection_notify_attempts < 5
           AND (c.rejection_notify_claimed_at IS NULL
                OR c.rejection_notify_claimed_at < now() - interval '5 minutes')
           AND (p_id IS NULL OR c.id = p_id)
         ORDER BY c.date_time
         LIMIT GREATEST(p_limit, 1)
         FOR UPDATE SKIP LOCKED
     )
    RETURNING r.*;
$function$;

REVOKE ALL ON FUNCTION public.claim_reservation_rejections(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reservation_rejections(integer, uuid) TO service_role;
