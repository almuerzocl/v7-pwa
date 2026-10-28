-- 015_security_function_search_path.sql
-- Fix de seguridad (lints Supabase 2026-09-30, hallazgo MEDIO #4: function_search_path_mutable).
--
-- Fija search_path = 'public' en las funciones que no lo tenían (incluye las de la migración 008
-- de inventario). Es ALTER FUNCTION: no toca cuerpos ni firmas, es idempotente y reversible con
-- ALTER FUNCTION ... RESET search_path.
--
-- Verificado contra producción: ninguna de estas funciones usa funciones de extensiones sin
-- calificar (uuid-ossp/pgcrypto/postgis viven en el schema `extensions`, que este search_path
-- no incluye); auth.uid() y demás ya van calificados.
-- Prioridad: las SECURITY DEFINER (find_user_public_info, check_restaurant_availability,
-- get_restaurant_dashboard_metrics, calculate_daily_reputation, get_restaurants_with_discounts_today,
-- get_restaurant_analytics_report, compute_daily_discount_cache, get_my_available_discounts,
-- get_user_restaurant_discounts*, create_reservation_atomic).
-- Si alguna firma ya no existe en la base destino, el ALTER falla y hay que ajustarla.

ALTER FUNCTION public.handle_updated_at() SET search_path = 'public';
ALTER FUNCTION public.find_user_public_info(text, text) SET search_path = 'public';
ALTER FUNCTION public.check_restaurant_availability(uuid, timestamptz, integer) SET search_path = 'public';
ALTER FUNCTION public.get_restaurant_dashboard_metrics(uuid, timestamptz) SET search_path = 'public';
ALTER FUNCTION public.calculate_daily_reputation() SET search_path = 'public';
ALTER FUNCTION public.check_advanced_restaurant_availability(uuid, timestamptz, integer, integer) SET search_path = 'public';
ALTER FUNCTION public.get_restaurants_with_discounts_today() SET search_path = 'public';
ALTER FUNCTION public.get_restaurant_analytics_report(uuid, timestamptz, timestamptz) SET search_path = 'public';
ALTER FUNCTION public.compute_daily_discount_cache() SET search_path = 'public';
ALTER FUNCTION public.get_my_available_discounts(uuid, text, date) SET search_path = 'public';
ALTER FUNCTION public.get_user_restaurant_discounts(uuid, text, date) SET search_path = 'public';
ALTER FUNCTION public.get_user_restaurant_discounts_direct(uuid, text, date) SET search_path = 'public';
ALTER FUNCTION public.create_reservation_atomic(uuid, uuid, timestamptz, integer, jsonb) SET search_path = 'public';
ALTER FUNCTION public.inventory_check_availability(jsonb) SET search_path = 'public';
ALTER FUNCTION public.inventory_items_needed(jsonb) SET search_path = 'public';
ALTER FUNCTION public.inventory_caller_role() SET search_path = 'public';
ALTER FUNCTION public.inventory_movements_immutable() SET search_path = 'public';
ALTER FUNCTION public.takeaway_orders_client_guard() SET search_path = 'public';
ALTER FUNCTION public.menu_items_inventory_guard() SET search_path = 'public';
ALTER FUNCTION public.auto_approve_takeaway_order() SET search_path = 'public';
ALTER FUNCTION public.auto_approve_reservation() SET search_path = 'public';
