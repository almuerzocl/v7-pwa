-- Prueba de 031_reservation_confirmation_notified.sql contra datos REALES de produccion (kqanordhsmbtcwtjtrme).
-- Un unico DO que termina en RAISE EXCEPTION: revierte todo (columnas, filas de prueba y funcion). El resultado
-- llega como texto del error 'TEST_REPORT'. Bloque $m031$ = copia literal de la migracion. Requiere 031 NO aplicada.
DO $test$
DECLARE
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    rep text := '';
    total_before int; marked int; n int; a uuid; b uuid; c uuid; d uuid; e uuid; got int; att int;
BEGIN
    SELECT count(*) INTO total_before FROM public.reservations;
    EXECUTE $m031$-- 031: correos de reserva SOLO al confirmarse -- marca de envio, intentos y reclamo atomico.
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
$m031$;

    SELECT count(*) INTO marked FROM public.reservations WHERE confirmation_notified_at IS NOT NULL;
    rep := rep || format('backfill: total_antes=%s marcadas=%s (esperado igual)%s', total_before, marked, E'\n');

    -- filas de prueba (status explicito: el trigger solo transforma PENDIENTE)
    INSERT INTO public.reservations (restaurant_id, organizer_id, date_time, status, party_size, unique_code, organizer_reputation_snapshot)
      VALUES (rid, uB, now() + interval '3 day', 'CONFIRMADA', 2, 'T31A0001', 100) RETURNING id INTO a;
    INSERT INTO public.reservations (restaurant_id, organizer_id, date_time, status, party_size, unique_code, organizer_reputation_snapshot)
      VALUES (rid, uB, now() + interval '3 day', 'RECHAZADA', 2, 'T31B0002', 100) RETURNING id INTO b;
    INSERT INTO public.reservations (restaurant_id, organizer_id, date_time, status, party_size, unique_code, organizer_reputation_snapshot)
      VALUES (rid, uB, now() - interval '1 day', 'CONFIRMADA', 2, 'T31C0003', 100) RETURNING id INTO c;
    INSERT INTO public.reservations (restaurant_id, organizer_id, date_time, status, party_size, unique_code, organizer_reputation_snapshot)
      VALUES (rid, uB, now() + interval '4 day', 'CONFIRMADA', 2, 'T31D0004', 100) RETURNING id INTO d;

    -- 1) reclama solo la CONFIRMADA futura (a y d), no la rechazada ni la pasada
    SELECT count(*) INTO got FROM public.claim_reservation_confirmations(50, NULL);
    rep := rep || format('claim1: reclamadas=%s (esperado 2: solo confirmadas futuras)%s', got, E'\n');
    -- 2) segunda ejecucion inmediata: reclamo vigente -> 0 (no se envia dos veces)
    SELECT count(*) INTO got FROM public.claim_reservation_confirmations(50, NULL);
    rep := rep || format('claim2 inmediato: reclamadas=%s (esperado 0)%s', got, E'\n');
    -- 3) reclamo vencido y reintento: vuelve a reclamarse, intentos suben; tope 5
    FOR n IN 2..6 LOOP
        UPDATE public.reservations SET confirmation_notify_claimed_at = now() - interval '10 minutes' WHERE id = a;
        SELECT count(*) INTO got FROM public.claim_reservation_confirmations(50, a);
        SELECT confirmation_notify_attempts INTO att FROM public.reservations WHERE id = a;
        rep := rep || format('reintento intento#%s: reclamada=%s intentos=%s%s', n, got, att, E'\n');
    END LOOP;
    -- 4) ya marcada como enviada: no se reclama
    UPDATE public.reservations SET confirmation_notified_at = now(), confirmation_notify_claimed_at = NULL, confirmation_notify_attempts = 0 WHERE id = d;
    SELECT count(*) INTO got FROM public.claim_reservation_confirmations(50, d);
    rep := rep || format('ya enviada: reclamadas=%s (esperado 0)%s', got, E'\n');
    -- 5) privilegios
    rep := rep || format('privilegios anon=%s authenticated=%s service_role=%s (esperado f,f,t)%s',
        has_function_privilege('anon','public.claim_reservation_confirmations(integer,uuid)','execute'),
        has_function_privilege('authenticated','public.claim_reservation_confirmations(integer,uuid)','execute'),
        has_function_privilege('service_role','public.claim_reservation_confirmations(integer,uuid)','execute'), E'\n');

    RAISE EXCEPTION 'TEST_REPORT%', E'\n' || rep;
END
$test$;
