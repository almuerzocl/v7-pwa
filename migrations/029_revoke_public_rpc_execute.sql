-- 029_revoke_public_rpc_execute.sql
-- Quita EXECUTE a anon y authenticated sobre las dos últimas funciones SECURITY DEFINER que el
-- navegador llamaba directo (las dejó públicas a propósito la 016, Evolutivo B). Desde este cambio
-- la PWA las ejecuta solo en su servidor con service_role:
--   check_restaurant_availability(uuid, timestamptz, integer)  -> GET /api/availability
--   get_restaurants_with_discounts_today()                     -> GET /api/restaurants-with-discounts
--
-- ORDEN: aplicar DESPUÉS de desplegar la PWA con esas rutas. Si se aplica antes, el listado pierde
-- los logos de descuento y la disponibilidad del wizard deja pasar sin validar (el cupo igual lo
-- revalida create_reservation_atomic al crear la reserva).
--
-- Verificado el 2026-10-04: 0 usos en admin-dashboard, restaurant-dashboard, public-tickets y
-- discounts; 0 dependientes en la base (funciones, políticas, pg_cron).
--
-- Aplicar en el SQL Editor de Supabase (producción), con confirmación explícita del usuario.

BEGIN;

REVOKE ALL ON FUNCTION public.check_restaurant_availability(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_restaurant_availability(uuid, timestamptz, integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_restaurants_with_discounts_today() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_restaurants_with_discounts_today() TO service_role;

COMMIT;

-- Verificación posterior (solo lectura): debe salir solo postgres y service_role en ambas.
--   SELECT p.proname, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('check_restaurant_availability','get_restaurants_with_discounts_today');
--   SELECT has_function_privilege('anon', 'public.get_restaurants_with_discounts_today()', 'EXECUTE');      -- false
--   SELECT has_function_privilege('authenticated', 'public.check_restaurant_availability(uuid, timestamptz, integer)', 'EXECUTE'); -- false

-- ROLLBACK (restaura el estado dejado por la 016: públicas):
-- BEGIN;
--   GRANT EXECUTE ON FUNCTION public.check_restaurant_availability(uuid, timestamptz, integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_restaurants_with_discounts_today() TO anon, authenticated;
-- COMMIT;
