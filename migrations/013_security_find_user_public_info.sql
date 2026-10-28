-- 013_security_find_user_public_info.sql
-- Fix de seguridad (lints Supabase 2026-09-30, hallazgo CRÍTICO #2).
--
-- Problema: find_user_public_info(email, phone) era SECURITY DEFINER y ejecutable por anon:
-- un oráculo para resolver email/teléfono -> (id, nombre, apellido) sin autenticarse.
--
-- No es redundante con searchProfileByEmailAction (restaurant-dashboard, usa la sesión del
-- staff) ni se puede simplemente borrar: el PWA la usa (ReservationWizard -> matchExistingUser)
-- para vincular invitados con usuarios existentes. Por eso se mueve a una server action del PWA
-- (src/app/actions/guests-actions.ts: usuario autenticado + rate limit, devuelve solo el id)
-- que la llama con service_role, y aquí se revoca el acceso desde cliente.
--
-- ORDEN DE DESPLIEGUE: primero desplegar el PWA con matchExistingUserAction (Cloud Build) y
-- recién después aplicar esta migración; si no, el wizard deja de vincular invitados
-- (falla en silencio: matchExistingUser devuelve null).
--
-- NOTA: no cierra la enumeración por otra vía. profiles tiene la policy "Public profiles are
-- viewable by everyone" (SELECT true) y anon/authenticated tienen SELECT sobre todas las
-- columnas (email, teléfono...). Queda como hallazgo aparte (ver roadmap de plataforma).

ALTER FUNCTION public.find_user_public_info(text, text) SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION public.find_user_public_info(text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.find_user_public_info(text, text) TO service_role;
