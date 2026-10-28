-- 016_security_definer_exposure.sql
-- Fix de seguridad (lints Supabase 2026-09-30, Evolutivo B):
-- funciones SECURITY DEFINER de `public` ejecutables por PUBLIC/anon/authenticated.
--
-- Verificado contra producción (kqanordhsmbtcwtjtrme) con pg_proc / has_function_privilege,
-- pg_cron y el código de los 4 componentes (pwa, admin-dashboard, restaurant-dashboard,
-- public-tickets). Decisión por función:
--
--  (c) solo service_role  (server actions con supabaseAdmin, pg_cron o sin uso):
--      create_reservation_atomic      -> pwa/src/app/actions/reservation-create-action.ts (service_role,
--                                        tras verifyUser). Hoy anon podía crear reservas con cualquier organizer_id.
--      compute_daily_discount_cache   -> pg_cron 'discount-cache-refresh' (corre como postgres),
--                                        pwa/api/cron/compute-discounts y admin-dashboard/actions/discounts.ts (service_role).
--      calculate_daily_reputation     -> sin callers en código ni pg_cron. Muta reputación.
--      find_user_public_info          -> re-afirma 013 (en producción seguía abierta). Ver ORDEN DE DESPLIEGUE.
--      notify_restaurant_admins       -> llamada desde el navegador (pwa/lib/notifications.ts) pero YA ROTA:
--                                        inserta en notifications.resource_id y lee restaurants.owner_id, columnas que
--                                        no existen (error 42703 en cada llamada). Revocar no cambia el comportamiento
--                                        actual y cierra el bypass de RLS. Las notificaciones reales salen de
--                                        transition_status / dashboard-actions.
--  (b) valida internamente / solo authenticated:
--      get_restaurant_dashboard_metrics, get_restaurant_analytics_report -> se llaman con la sesión del staff
--          (restaurant-dashboard/actions/dashboard-actions.ts) pero no validaban nada: cualquiera con la anon key
--          leía métricas y ventas de cualquier restaurante. Se agrega guard can_access_restaurant().
--      get_user_restaurant_discounts_direct (usada por pwa), get_my_available_discounts, get_user_restaurant_discounts:
--          ya filtran por auth.uid(); se quita anon (el cliente PWA ya devuelve [] ante error).
--  (a) siguen públicas (navegación anónima), con GRANT explícito:
--      check_restaurant_availability, get_restaurants_with_discounts_today.
--
-- ORDEN DE DESPLIEGUE: antes de aplicar, confirmar que la revisión de Cloud Run de `almuerzo-pwa` incluye
-- guests-actions.ts (matchExistingUserAction, PR #13); si no, el wizard deja de vincular invitados.
--
-- Rollback: ver bloque al final.

-- ---------------------------------------------------------------------------
-- 1. Helper de autorización por restaurante (staff del restaurante o SUPER_ADMIN)
--    Criterio idéntico a restaurant-dashboard/src/lib/auth-context.ts (fetchProfileForUser).
--    service_role (JWT) pasa; anon y usuarios sin perfil de staff no.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_restaurant(p_restaurant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
    SELECT COALESCE(auth.role() = 'service_role', false)
        OR EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND (
                  upper(p.role) = 'SUPER_ADMIN'
                  OR (p.restaurant_id IS NOT NULL AND p.restaurant_id = p_restaurant_id AND upper(p.role) <> 'USER')
              )
        );
$$;

REVOKE ALL ON FUNCTION public.can_access_restaurant(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.can_access_restaurant(uuid) TO service_role;
-- (las funciones SECURITY DEFINER de abajo la invocan como owner, no necesitan EXECUTE del llamador)

-- ---------------------------------------------------------------------------
-- 2. Guard en las RPC de métricas: el cuerpo original queda intacto como *_impl (privada)
--    y la función pública, con la misma firma, valida antes de delegar.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.get_restaurant_dashboard_metrics(uuid, timestamptz)
    RENAME TO _get_restaurant_dashboard_metrics_impl;
ALTER FUNCTION public._get_restaurant_dashboard_metrics_impl(uuid, timestamptz)
    SET search_path = 'public';
REVOKE ALL ON FUNCTION public._get_restaurant_dashboard_metrics_impl(uuid, timestamptz)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_restaurant_dashboard_metrics(
    p_restaurant_id uuid,
    p_current_time  timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
    IF NOT public.can_access_restaurant(p_restaurant_id) THEN
        RAISE EXCEPTION 'No tiene acceso a este restaurante.' USING ERRCODE = '42501';
    END IF;
    RETURN public._get_restaurant_dashboard_metrics_impl(p_restaurant_id, p_current_time);
END;
$$;

ALTER FUNCTION public.get_restaurant_analytics_report(uuid, timestamptz, timestamptz)
    RENAME TO _get_restaurant_analytics_report_impl;
ALTER FUNCTION public._get_restaurant_analytics_report_impl(uuid, timestamptz, timestamptz)
    SET search_path = 'public';
REVOKE ALL ON FUNCTION public._get_restaurant_analytics_report_impl(uuid, timestamptz, timestamptz)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_restaurant_analytics_report(
    p_restaurant_id uuid,
    p_start_time    timestamptz,
    p_end_time      timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
    IF NOT public.can_access_restaurant(p_restaurant_id) THEN
        RAISE EXCEPTION 'No tiene acceso a este restaurante.' USING ERRCODE = '42501';
    END IF;
    RETURN public._get_restaurant_analytics_report_impl(p_restaurant_id, p_start_time, p_end_time);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. REVOKE / GRANT explícitos por función
-- ---------------------------------------------------------------------------

-- (c) solo service_role
REVOKE ALL ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.compute_daily_discount_cache() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.compute_daily_discount_cache() TO service_role;

REVOKE ALL ON FUNCTION public.calculate_daily_reputation() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.calculate_daily_reputation() TO service_role;

REVOKE ALL ON FUNCTION public.find_user_public_info(text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.find_user_public_info(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.notify_restaurant_admins(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.notify_restaurant_admins(uuid, text, text, text, uuid) TO service_role;

-- (b) authenticated + service_role (guard interno o filtro por auth.uid())
REVOKE ALL ON FUNCTION public.get_restaurant_dashboard_metrics(uuid, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_restaurant_dashboard_metrics(uuid, timestamptz) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_restaurant_analytics_report(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_restaurant_analytics_report(uuid, timestamptz, timestamptz) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_user_restaurant_discounts_direct(uuid, text, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_user_restaurant_discounts_direct(uuid, text, date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_user_restaurant_discounts(uuid, text, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_user_restaurant_discounts(uuid, text, date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_my_available_discounts(uuid, text, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_available_discounts(uuid, text, date) TO authenticated, service_role;

-- (a) públicas a propósito (navegación anónima: disponibilidad y sellos de descuento en el home)
REVOKE ALL ON FUNCTION public.check_restaurant_availability(uuid, timestamptz, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.check_restaurant_availability(uuid, timestamptz, integer) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_restaurants_with_discounts_today() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_restaurants_with_discounts_today() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Rollback (manual):
--   DROP FUNCTION public.get_restaurant_dashboard_metrics(uuid, timestamptz);
--   ALTER FUNCTION public._get_restaurant_dashboard_metrics_impl(uuid, timestamptz) RENAME TO get_restaurant_dashboard_metrics;
--   DROP FUNCTION public.get_restaurant_analytics_report(uuid, timestamptz, timestamptz);
--   ALTER FUNCTION public._get_restaurant_analytics_report_impl(uuid, timestamptz, timestamptz) RENAME TO get_restaurant_analytics_report;
--   DROP FUNCTION public.can_access_restaurant(uuid);
--   GRANT EXECUTE ON FUNCTION <cada función> TO PUBLIC, anon, authenticated, service_role;   -- estado previo
-- ---------------------------------------------------------------------------
