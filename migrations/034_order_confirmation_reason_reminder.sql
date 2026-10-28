-- 034: correos de PEDIDOS solo al aprobarse, motivo de rechazo de reservas y marca del recordatorio de 30 min.
--
-- (1) Pedidos para llevar -- misma logica que las reservas (031): el correo "Pedido confirmado" sale UNA vez y solo
--     cuando el pedido esta APROBADA (autoaprobado, aprobado a mano o tomado por el propio restaurante). PENDIENTE no
--     envia nada. El rechazo ya lo avisa el dashboard (solo al cliente, con motivo) y no cambia.
--     takeaway_orders: confirmation_notified_at, confirmation_notify_attempts (tope 5), confirmation_notify_claimed_at
--     (reclamo con vencimiento de 5 min). claim_order_confirmations() reclama pedidos APROBADA o PREPARANDO sin marca,
--     creados hace menos de 12 h (tope de antiguedad: un pedido no tiene fecha futura), con FOR UPDATE SKIP LOCKED.
-- (2) reservations.cancellation_reason (text, nullable): motivo que el restaurante da al RECHAZAR. Lo escribe
--     updateReservationStatusAction del dashboard (antes escribia una columna inexistente y fallaba si recibia motivo)
--     y lo incluye el correo de rechazo al organizador.
-- (3) reservations.reminder_30m_sent_at: marca atomica del recordatorio de 30 minutos (antes: metadata JSON leida y
--     reescrita sin atomicidad, riesgo de duplicados). El reclamo es un UPDATE condicional (... IS NULL).
-- BACKFILL: todos los pedidos y reservas existentes quedan marcados (sin correos ni recordatorios retroactivos).
-- No crea tablas (no aplica el GRANT de tablas nuevas). Solo service_role ejecuta claim_order_confirmations().
-- Orden de despliegue: aplicar ANTES de desplegar la PWA y el dashboard.
--
-- VERIFICACION:
--   select count(*) total, count(*) filter (where confirmation_notified_at is not null) marcados from takeaway_orders;
--   select count(*) total, count(*) filter (where reminder_30m_sent_at is not null) marcadas from reservations;
--     -> marcados = total en ambas
--   select has_function_privilege('anon','public.claim_order_confirmations(integer,uuid)','execute'),
--          has_function_privilege('authenticated','public.claim_order_confirmations(integer,uuid)','execute'),
--          has_function_privilege('service_role','public.claim_order_confirmations(integer,uuid)','execute');
--     -> false, false, true
--   select count(*) from information_schema.columns where table_schema='public' and
--     ((table_name='reservations' and column_name in ('cancellation_reason','reminder_30m_sent_at')) or
--      (table_name='takeaway_orders' and column_name like 'confirmation_%'));   -> 5
-- ROLLBACK:
--   drop function if exists public.claim_order_confirmations(integer, uuid);
--   drop index if exists public.idx_takeaway_orders_confirmation_pending;
--   alter table public.takeaway_orders drop column if exists confirmation_notified_at,
--     drop column if exists confirmation_notify_attempts, drop column if exists confirmation_notify_claimed_at;
--   alter table public.reservations drop column if exists cancellation_reason, drop column if exists reminder_30m_sent_at;

ALTER TABLE public.reservations
    ADD COLUMN IF NOT EXISTS cancellation_reason text,
    ADD COLUMN IF NOT EXISTS reminder_30m_sent_at timestamptz;

UPDATE public.reservations
   SET reminder_30m_sent_at = now()
 WHERE reminder_30m_sent_at IS NULL;

ALTER TABLE public.takeaway_orders
    ADD COLUMN IF NOT EXISTS confirmation_notified_at timestamptz,
    ADD COLUMN IF NOT EXISTS confirmation_notify_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS confirmation_notify_claimed_at timestamptz;

UPDATE public.takeaway_orders
   SET confirmation_notified_at = now()
 WHERE confirmation_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_takeaway_orders_confirmation_pending
    ON public.takeaway_orders (created_at)
    WHERE status IN ('APROBADA', 'PREPARANDO') AND confirmation_notified_at IS NULL;

CREATE OR REPLACE FUNCTION public.claim_order_confirmations(p_limit integer DEFAULT 20, p_id uuid DEFAULT NULL)
 RETURNS SETOF public.takeaway_orders
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
    UPDATE public.takeaway_orders o
       SET confirmation_notify_claimed_at = now(),
           confirmation_notify_attempts = o.confirmation_notify_attempts + 1
     WHERE o.id IN (
        SELECT c.id
          FROM public.takeaway_orders c
         WHERE c.status IN ('APROBADA', 'PREPARANDO')
           AND c.confirmation_notified_at IS NULL
           AND c.created_at > now() - interval '12 hours'
           AND c.confirmation_notify_attempts < 5
           AND (c.confirmation_notify_claimed_at IS NULL
                OR c.confirmation_notify_claimed_at < now() - interval '5 minutes')
           AND (p_id IS NULL OR c.id = p_id)
         ORDER BY c.created_at
         LIMIT GREATEST(p_limit, 1)
         FOR UPDATE SKIP LOCKED
     )
    RETURNING o.*;
$function$;

REVOKE ALL ON FUNCTION public.claim_order_confirmations(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_confirmations(integer, uuid) TO service_role;
