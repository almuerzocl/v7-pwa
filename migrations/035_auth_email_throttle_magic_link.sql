-- 035: la tabla de límites de correos de autenticación admite también el enlace mágico (kind 'magic_link').
--
-- Por qué: `auth_email_throttle` (restaurant-dashboard/migrations/002, aplicada 2026-10-06) solo aceptaba kind = 'password_reset'
-- (CHECK). La PWA mueve el envío del enlace mágico al servidor con los mismos límites por correo e IP, y necesita su propio kind
-- para que los cupos de recuperación y de acceso no se mezclen.
--
-- Solo se ensancha el CHECK: no cambian grants ni policies (la tabla sigue siendo solo service_role, sin acceso de anon/authenticated).
-- Orden de despliegue: aplicar ANTES de desplegar el código que escribe kind 'magic_link' (si no, el INSERT falla y el endpoint no envía
-- nada: falla cerrado).
--
-- Verificación posterior:
--   select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.auth_email_throttle'::regclass and contype = 'c' and conname like '%kind%';
-- Rollback (solo si no hay filas 'magic_link'):
--   alter table public.auth_email_throttle drop constraint auth_email_throttle_kind_check;
--   alter table public.auth_email_throttle add constraint auth_email_throttle_kind_check check (kind in ('password_reset'));

BEGIN;
ALTER TABLE public.auth_email_throttle DROP CONSTRAINT IF EXISTS auth_email_throttle_kind_check;
ALTER TABLE public.auth_email_throttle ADD CONSTRAINT auth_email_throttle_kind_check CHECK (kind IN ('password_reset', 'magic_link'));
COMMIT;
