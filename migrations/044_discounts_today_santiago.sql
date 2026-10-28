-- 044: get_restaurants_with_discounts_today usaba CURRENT_DATE (UTC). En Santiago (UTC-3/-4)
-- desde las ~21:00 el listado "Con descuento" mostraba los descuentos del día siguiente.
-- daily_discount_cache.cache_date lo escribe almuerzo-discounts con la fecha de Santiago
-- (rules.ts: santiagoToday), así que la consulta debe comparar con esa misma fecha.
-- Solo cambia el cuerpo; CREATE OR REPLACE conserva los GRANT (solo service_role).
CREATE OR REPLACE FUNCTION public.get_restaurants_with_discounts_today()
 RETURNS TABLE(restaurant_id uuid, institution_logos text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY SELECT ddc.restaurant_id, array_agg(DISTINCT ddc.institution_logo_url) FILTER (WHERE ddc.institution_logo_url IS NOT NULL)
    FROM public.daily_discount_cache ddc JOIN public.restaurants r ON r.id = ddc.restaurant_id AND NOT r.plan_hidden
    WHERE ddc.cache_date = (now() AT TIME ZONE 'America/Santiago')::date GROUP BY ddc.restaurant_id;
END;
$function$;
