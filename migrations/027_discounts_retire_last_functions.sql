-- 027_discounts_retire_last_functions.sql
-- Retira las dos últimas funciones legacy de descuentos, ya reemplazadas por el servicio almuerzo-discounts.
--
-- Verificado el 2026-10-04 antes de redactar:
--   * 0 usos en el código de pwa, admin-dashboard, restaurant-dashboard, public-tickets y discounts (origin/main).
--   * 0 dependientes en la base (sin triggers, políticas ni otras funciones que las llamen).
--   * Se eliminó la versión iOS (ios-pwa y la app nativa Expo), que eran las únicas que aún las usaban.
--   * El refresco del caché lo hace solo Cloud Scheduler -> almuerzo-discounts (discounts-refresh-cache, 03:45 Santiago).
--
-- Aplicar en el SQL Editor de Supabase (producción), con confirmación explícita del usuario.

BEGIN;

DROP FUNCTION IF EXISTS public.get_user_restaurant_discounts_direct(uuid, text, date);
DROP FUNCTION IF EXISTS public.compute_daily_discount_cache();

COMMIT;

-- Verificación posterior (solo lectura):
--   SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname IN ('get_user_restaurant_discounts_direct','compute_daily_discount_cache'); -- 0 filas
--   SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname ILIKE '%discount%';  -- solo get_restaurants_with_discounts_today

-- ROLLBACK (manual, solo si hiciera falta restaurar el comportamiento anterior):
-- BEGIN;
--   CREATE OR REPLACE FUNCTION public.get_user_restaurant_discounts_direct(p_restaurant_id uuid, p_service_type text, p_date date DEFAULT CURRENT_DATE)
--    RETURNS TABLE(discount_id uuid, institution_id uuid, institution_name text, institution_logo_url text, discount_name text, amount integer, amount_type text, conditions text)
--    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
--   AS $function$
--   DECLARE
--       day_codes text[] := ARRAY['SU','MO','TU','WE','TH','FR','SA'];
--       day_code text;
--   BEGIN
--       day_code := day_codes[EXTRACT(DOW FROM p_date)::int + 1];
--       RETURN QUERY
--       SELECT DISTINCT id.id, di.id, di.name, di.logo_url, id.name, id.amount, id.amount_type, id.conditions
--       FROM public.institution_discounts id
--       JOIN public.discount_institutions di ON di.id = id.institution_id
--       JOIN public.user_institutions ui ON ui.institution_id = di.id AND ui.user_id = auth.uid() AND ui.is_active = true
--       WHERE id.is_active = true AND di.is_active = true
--         AND p_date BETWEEN id.start_date AND id.end_date
--         AND day_code = ANY(id.valid_days)
--         AND p_service_type = ANY(id.service_scope)
--         AND p_restaurant_id = ANY(id.restaurant_ids);
--   END;
--   $function$;
--   REVOKE EXECUTE ON FUNCTION public.get_user_restaurant_discounts_direct(uuid, text, date) FROM PUBLIC, anon;
--   GRANT EXECUTE ON FUNCTION public.get_user_restaurant_discounts_direct(uuid, text, date) TO authenticated, service_role;
--
--   -- compute_daily_discount_cache(): su lógica vive ahora en el servicio almuerzo-discounts (POST /internal/refresh-cache).
--   -- Restaurarla desde el historial de git de 001_discount_institutions.sql / el repo v5-discounts solo si se vuelve a pg_cron
--   -- (lo cual contradice la regla de que los crons viven en Cloud Run).
-- COMMIT;
