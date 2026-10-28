-- Direct (cache-free) lookup for user+restaurant discounts.
-- Rationale: the cached RPC (get_user_restaurant_discounts) depends on
-- compute_daily_discount_cache having run for the requested date. When a
-- discount is just created, when the chosen date is outside the 10-day cache
-- window, or when the auth session hydrates slightly late, the cached RPC
-- silently returns empty — which surfaced as "discount only works once per
-- session". This RPC queries the source tables live and is race-free.

CREATE OR REPLACE FUNCTION public.get_user_restaurant_discounts_direct(
    p_restaurant_id uuid,
    p_service_type text,
    p_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    discount_id uuid,
    institution_id uuid,
    institution_name text,
    institution_logo_url text,
    discount_name text,
    amount integer,
    amount_type text,
    conditions text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    day_codes text[] := ARRAY['SU','MO','TU','WE','TH','FR','SA'];
    day_code text;
BEGIN
    day_code := day_codes[EXTRACT(DOW FROM p_date)::int + 1];

    RETURN QUERY
    SELECT DISTINCT
        id.id            AS discount_id,
        di.id            AS institution_id,
        di.name          AS institution_name,
        di.logo_url      AS institution_logo_url,
        id.name          AS discount_name,
        id.amount,
        id.amount_type,
        id.conditions
    FROM public.institution_discounts id
    JOIN public.discount_institutions di ON di.id = id.institution_id
    JOIN public.user_institutions ui
        ON ui.institution_id = di.id
        AND ui.user_id = auth.uid()
        AND ui.is_active = true
    WHERE id.is_active = true
      AND di.is_active = true
      AND p_date BETWEEN id.start_date AND id.end_date
      AND day_code = ANY(id.valid_days)
      AND p_service_type = ANY(id.service_scope)
      AND p_restaurant_id = ANY(id.restaurant_ids);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_restaurant_discounts_direct(uuid, text, date) TO authenticated;
