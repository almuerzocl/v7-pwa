-- 026_discounts_retire_legacy.sql
-- Retira lo que reemplazó el servicio almuerzo-discounts (Cloud Run). Un solo decisor de reglas de descuentos.
--
-- Verificado el 2026-10-04 antes de redactar:
--   * discounts-refresh-cache (Cloud Scheduler, 03:45 Santiago) corre y responde 200 (hoy 06:45 UTC).
--   * La PWA y el admin-dashboard ya no llaman a nada de esto (PWA main sin usos; admin vía el servicio).
--   * Los avisos del panel de Supabase "SECURITY DEFINER ejecutable" para estas funciones desaparecen.
--
-- NO se borran todavía (siguen en uso por apps NO desplegadas; portarlas antes de retirarlas):
--   * get_user_restaurant_discounts_direct  -> ios-pwa/src/lib/core-business/discounts.ts y la app iOS
--   * compute_daily_discount_cache          -> ios-pwa/src/app/api/cron/compute-discounts/route.ts
--
-- Aplicar en el SQL Editor de Supabase (producción), con confirmación explícita del usuario.

BEGIN;

-- 1) El refresco del caché lo hace el servicio (Cloud Scheduler). Quitar el job duplicado de pg_cron.
SELECT cron.unschedule('discount-cache-refresh');

-- 2) Funciones sin ningún consumidor.
--    get_my_available_discounts: apunta a tablas inexistentes (public.discounts, public.institutions); nunca pudo funcionar.
--    get_user_restaurant_discounts: lectura sobre el caché, sin uso en el checkout.
DROP FUNCTION IF EXISTS public.get_my_available_discounts(uuid, text, date);
DROP FUNCTION IF EXISTS public.get_user_restaurant_discounts(uuid, text, date);

COMMIT;

-- Verificación posterior (solo lectura):
--   SELECT count(*) FROM cron.job WHERE jobname = 'discount-cache-refresh';            -- 0
--   SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname IN ('get_my_available_discounts','get_user_restaurant_discounts'); -- 0 filas

-- ROLLBACK (manual; solo para restaurar el comportamiento anterior):
-- BEGIN;
--   SELECT cron.schedule('discount-cache-refresh', '0 5 * * *', 'SELECT compute_daily_discount_cache()');
--
--   CREATE OR REPLACE FUNCTION public.get_user_restaurant_discounts(p_restaurant_id uuid, p_service_type text, p_date date DEFAULT CURRENT_DATE)
--    RETURNS TABLE(discount_id uuid, institution_id uuid, institution_name text, institution_logo_url text, discount_name text, amount integer, amount_type text, conditions text)
--    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
--   AS $function$
--   BEGIN
--       RETURN QUERY
--       SELECT ddc.discount_id, ddc.institution_id, ddc.institution_name,
--           ddc.institution_logo_url, ddc.discount_name, ddc.amount, ddc.amount_type, ddc.conditions
--       FROM public.daily_discount_cache ddc
--       JOIN public.user_discount_cache udc
--           ON udc.institution_id = ddc.institution_id
--           AND udc.cache_date = ddc.cache_date
--           AND udc.user_id = auth.uid()
--       WHERE ddc.restaurant_id = p_restaurant_id
--         AND ddc.cache_date = p_date
--         AND p_service_type = ANY(ddc.service_scope);
--   END;
--   $function$;
--   REVOKE EXECUTE ON FUNCTION public.get_user_restaurant_discounts(uuid, text, date) FROM PUBLIC, anon;
--   GRANT EXECUTE ON FUNCTION public.get_user_restaurant_discounts(uuid, text, date) TO authenticated, service_role;
--
--   -- get_my_available_discounts no se restaura: dependía de public.discounts / public.institutions, que no existen.
-- COMMIT;
