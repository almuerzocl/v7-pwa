-- =========================================================================================
-- DISCOUNT INSTITUTIONS SYSTEM
-- Migration: 001_discount_institutions.sql
-- Date: 2026-04-09
-- =========================================================================================

-- 1. DISCOUNT INSTITUTIONS
--    An institution is a company/org that provides discounts (e.g., Banco Chile, UANDES, Sodexo)
CREATE TABLE IF NOT EXISTS public.discount_institutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    logo_url text,
    rules text CHECK (char_length(rules) <= 300),
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT timezone('utc', now()) NOT NULL,
    updated_at timestamptz DEFAULT timezone('utc', now()) NOT NULL
);

ALTER TABLE public.discount_institutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Institutions viewable by everyone" ON public.discount_institutions FOR SELECT USING (true);
CREATE POLICY "Institutions managed by service role" ON public.discount_institutions FOR ALL USING (auth.role() = 'service_role');

-- 2. INSTITUTION DISCOUNTS (specific discount configs under an institution)
--    restaurant_ids is embedded directly — no linking table needed
CREATE TABLE IF NOT EXISTS public.institution_discounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES public.discount_institutions(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text CHECK (char_length(description) <= 300),
    amount integer NOT NULL CHECK (amount > 0),
    amount_type text NOT NULL CHECK (amount_type IN ('percent', 'fixed')) DEFAULT 'percent',
    start_date date NOT NULL,
    end_date date NOT NULL,
    valid_days text[] DEFAULT '{"MO","TU","WE","TH","FR","SA","SU"}'::text[],
    service_scope text[] NOT NULL DEFAULT '{"reservation","takeaway"}'::text[],
    restaurant_ids uuid[] NOT NULL DEFAULT '{}',
    conditions text CHECK (char_length(conditions) <= 300),
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT timezone('utc', now()) NOT NULL,
    updated_at timestamptz DEFAULT timezone('utc', now()) NOT NULL,
    CONSTRAINT valid_date_range CHECK (end_date >= start_date)
);

CREATE INDEX idx_institution_discounts_restaurant_ids ON public.institution_discounts USING GIN (restaurant_ids);

ALTER TABLE public.institution_discounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Institution discounts viewable by everyone" ON public.institution_discounts FOR SELECT USING (true);
CREATE POLICY "Institution discounts managed by service role" ON public.institution_discounts FOR ALL USING (auth.role() = 'service_role');

-- 3. USER-INSTITUTION MEMBERSHIP (which institutions a user belongs to)
CREATE TABLE IF NOT EXISTS public.user_institutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    institution_id uuid NOT NULL REFERENCES public.discount_institutions(id) ON DELETE CASCADE,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT timezone('utc', now()) NOT NULL,
    UNIQUE(user_id, institution_id)
);

ALTER TABLE public.user_institutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own memberships" ON public.user_institutions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users manage own memberships" ON public.user_institutions FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Service role manages memberships" ON public.user_institutions FOR ALL USING (auth.role() = 'service_role');

-- 4. DAILY DISCOUNT CACHE (pre-computed by cron at 2 AM)
--    Stores restaurant -> active discounts for a given date
CREATE TABLE IF NOT EXISTS public.daily_discount_cache (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cache_date date NOT NULL,
    restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    discount_id uuid NOT NULL REFERENCES public.institution_discounts(id) ON DELETE CASCADE,
    institution_id uuid NOT NULL REFERENCES public.discount_institutions(id) ON DELETE CASCADE,
    institution_name text NOT NULL,
    institution_logo_url text,
    discount_name text NOT NULL,
    amount integer NOT NULL,
    amount_type text NOT NULL,
    service_scope text[] NOT NULL,
    conditions text,
    computed_at timestamptz DEFAULT timezone('utc', now()) NOT NULL,
    UNIQUE(cache_date, restaurant_id, discount_id)
);

CREATE INDEX idx_daily_discount_cache_date ON public.daily_discount_cache(cache_date);
CREATE INDEX idx_daily_discount_cache_restaurant ON public.daily_discount_cache(restaurant_id, cache_date);

ALTER TABLE public.daily_discount_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Daily cache viewable by everyone" ON public.daily_discount_cache FOR SELECT USING (true);
CREATE POLICY "Daily cache managed by service role" ON public.daily_discount_cache FOR ALL USING (auth.role() = 'service_role');

-- 5. USER DISCOUNT CACHE (pre-computed by cron at 2 AM)
--    Stores user -> institutions with active discounts for a given date
CREATE TABLE IF NOT EXISTS public.user_discount_cache (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cache_date date NOT NULL,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    institution_id uuid NOT NULL REFERENCES public.discount_institutions(id) ON DELETE CASCADE,
    institution_name text NOT NULL,
    computed_at timestamptz DEFAULT timezone('utc', now()) NOT NULL,
    UNIQUE(cache_date, user_id, institution_id)
);

CREATE INDEX idx_user_discount_cache_date ON public.user_discount_cache(cache_date);
CREATE INDEX idx_user_discount_cache_user ON public.user_discount_cache(user_id, cache_date);

ALTER TABLE public.user_discount_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own discount cache" ON public.user_discount_cache FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role manages discount cache" ON public.user_discount_cache FOR ALL USING (auth.role() = 'service_role');

-- 6. CRON FUNCTION: Compute daily discount caches
CREATE OR REPLACE FUNCTION public.compute_daily_discount_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    target_date date;
    day_code text;
    day_codes text[] := ARRAY['SU','MO','TU','WE','TH','FR','SA'];
    r_id uuid;
BEGIN
    -- Process today + 10 days
    FOR i IN 0..10 LOOP
        target_date := CURRENT_DATE + i;
        day_code := day_codes[EXTRACT(DOW FROM target_date)::int + 1];

        -- Clear existing cache for this date
        DELETE FROM public.daily_discount_cache WHERE cache_date = target_date;
        DELETE FROM public.user_discount_cache WHERE cache_date = target_date;

        -- Populate restaurant discount cache
        -- Unnest restaurant_ids from institution_discounts directly
        INSERT INTO public.daily_discount_cache (
            cache_date, restaurant_id, discount_id, institution_id,
            institution_name, institution_logo_url, discount_name,
            amount, amount_type, service_scope, conditions
        )
        SELECT
            target_date,
            unnest(id.restaurant_ids),
            id.id,
            di.id,
            di.name,
            di.logo_url,
            id.name,
            id.amount,
            id.amount_type,
            id.service_scope,
            id.conditions
        FROM public.institution_discounts id
        JOIN public.discount_institutions di ON di.id = id.institution_id
        WHERE id.is_active = true
          AND di.is_active = true
          AND target_date BETWEEN id.start_date AND id.end_date
          AND day_code = ANY(id.valid_days)
          AND array_length(id.restaurant_ids, 1) > 0
        ON CONFLICT (cache_date, restaurant_id, discount_id) DO NOTHING;

        -- Populate user discount cache
        INSERT INTO public.user_discount_cache (
            cache_date, user_id, institution_id, institution_name
        )
        SELECT DISTINCT
            target_date,
            ui.user_id,
            di.id,
            di.name
        FROM public.user_institutions ui
        JOIN public.discount_institutions di ON di.id = ui.institution_id
        WHERE ui.is_active = true
          AND di.is_active = true
          AND EXISTS (
              SELECT 1 FROM public.institution_discounts id
              WHERE id.institution_id = di.id
                AND id.is_active = true
                AND target_date BETWEEN id.start_date AND id.end_date
                AND day_code = ANY(id.valid_days)
                AND array_length(id.restaurant_ids, 1) > 0
          )
        ON CONFLICT (cache_date, user_id, institution_id) DO NOTHING;
    END LOOP;

    -- Clean up old cache (older than yesterday)
    DELETE FROM public.daily_discount_cache WHERE cache_date < CURRENT_DATE;
    DELETE FROM public.user_discount_cache WHERE cache_date < CURRENT_DATE;
END;
$$;

-- 7. RPC: Get matching discounts for a user at a restaurant (uses cache)
CREATE OR REPLACE FUNCTION public.get_user_restaurant_discounts(
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
BEGIN
    RETURN QUERY
    SELECT
        ddc.discount_id,
        ddc.institution_id,
        ddc.institution_name,
        ddc.institution_logo_url,
        ddc.discount_name,
        ddc.amount,
        ddc.amount_type,
        ddc.conditions
    FROM public.daily_discount_cache ddc
    JOIN public.user_discount_cache udc
        ON udc.institution_id = ddc.institution_id
        AND udc.cache_date = ddc.cache_date
        AND udc.user_id = auth.uid()
    WHERE ddc.restaurant_id = p_restaurant_id
      AND ddc.cache_date = p_date
      AND p_service_type = ANY(ddc.service_scope);
END;
$$;

-- 8. RPC: Get restaurants with active discounts today (for home page icons + CON DESCUENTO filter)
CREATE OR REPLACE FUNCTION public.get_restaurants_with_discounts_today()
RETURNS TABLE (
    restaurant_id uuid,
    institution_logos text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ddc.restaurant_id,
        array_agg(DISTINCT ddc.institution_logo_url) FILTER (WHERE ddc.institution_logo_url IS NOT NULL)
    FROM public.daily_discount_cache ddc
    WHERE ddc.cache_date = CURRENT_DATE
    GROUP BY ddc.restaurant_id;
END;
$$;
