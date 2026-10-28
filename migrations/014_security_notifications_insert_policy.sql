-- 014_security_notifications_insert_policy.sql
-- Fix de seguridad (lints Supabase 2026-09-30, hallazgo ALTO #3).
--
-- Problema: la policy "Service can insert notifications" incluía a authenticated con
-- WITH CHECK (true): cualquier usuario logueado podía insertar notificaciones a nombre de
-- cualquier user_id.
--
-- Verificado antes de quitar (código de pwa, restaurant-dashboard, admin-dashboard,
-- public-tickets): ningún cliente inserta en notifications; los contextos de notificaciones del
-- PWA y del dashboard solo hacen select/update sobre las propias. Los inserts reales vienen de
--   - dashboard-actions.ts (supabaseAdmin = service_role, bypassa RLS), y
--   - transition_status / notify_restaurant_admins (SECURITY DEFINER, owner postgres BYPASSRLS).
-- Ver también 012.

DROP POLICY IF EXISTS "Service can insert notifications" ON public.notifications;

CREATE POLICY "Service can insert notifications"
    ON public.notifications
    FOR INSERT
    TO service_role
    WITH CHECK (true);
