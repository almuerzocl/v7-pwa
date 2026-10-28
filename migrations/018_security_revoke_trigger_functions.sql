-- 018_security_revoke_trigger_functions.sql
-- Fix de seguridad (advisors 2026-09-30: anon/authenticated_security_definer_function_executable).
--
-- auto_approve_reservation() y auto_approve_takeaway_order() (migraciones 010/011) son funciones
-- de TRIGGER SECURITY DEFINER que quedaron con EXECUTE para PUBLIC/anon/authenticated por el
-- default de Supabase. Verificado en producción (kqanordhsmbtcwtjtrme):
--   - devuelven `trigger` y solo las usan tr_auto_approve_reservation (reservations) y
--     tr_auto_approve_takeaway_order (takeaway_orders);
--   - no las llama ningún código de los 4 componentes (ni como RPC).
-- Postgres NO revisa EXECUTE al disparar un trigger (solo al crearlo), así que revocarlo no
-- afecta a los triggers ni a las funciones que los activan (create_reservation_atomic, inserts
-- de takeaway). PostgREST ya rechaza llamarlas como RPC ("trigger functions can only be called
-- as triggers"); esto solo cierra el lint y deja el ACL explícito.
--
-- Esta migración toca únicamente ACL: no cambia cuerpos, firmas ni triggers.
-- Rollback: GRANT EXECUTE ON FUNCTION public.auto_approve_reservation(), public.auto_approve_takeaway_order()
--           TO PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.auto_approve_reservation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.auto_approve_reservation() TO service_role;

REVOKE ALL ON FUNCTION public.auto_approve_takeaway_order() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.auto_approve_takeaway_order() TO service_role;
