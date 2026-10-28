-- 042: OlivIA, asistente de almuerzo de la portada de la PWA.
--
-- Qué guarda:
--   olivia_config     una fila: interruptor (nace APAGADO), tope diario de consultas, tope mensual de gasto, modelo y precios.
--   olivia_usage      una fila por consulta del cliente (día en hora de Santiago, tokens y costo). Sirve para el tope diario y el mensual.
--   olivia_snapshots  copia del día: oferta de comida (offer), ficha física de los locales (venues) y pronóstico (weather).
--                     La construye el servidor una vez al día (Cloud Scheduler antes de las 11:00) y se reutiliza en toda la ventana
--                     de almuerzo (11:00-14:00, Chile). Un cambio de platos o de la ficha de un local la marca `stale` y el servidor
--                     la reconstruye en la próxima consulta (actualización por excepción).
--
-- Reglas (todas en la base, el servidor solo las lee):
--   * Tope diario: 3 consultas por usuario y día de Santiago (00:00 America/Santiago). Elite tiene el mismo tope.
--   * Cuenta una consulta que llegó al modelo ('ok'). Una consulta que falló antes de responder queda 'fallida' y no cuenta;
--     una 'reservada' que nunca se cerró deja de contar a los 3 minutos.
--   * Tope mensual de gasto: suma de olivia_usage.cost_usd del mes de Santiago + una reserva por consulta en vuelo.
--   * Solo service_role toca estas tablas y funciones (la PWA valida la sesión en el servidor y llama con service_role).
--
-- INTERRUPTOR:  UPDATE public.olivia_config SET enabled = true;   -- encender
--               UPDATE public.olivia_config SET enabled = false;  -- apagar (la portada vuelve a ser idéntica a la de antes)
--
-- Orden de despliegue: aplicar esta migración -> desplegar la PWA -> crear el job de Scheduler -> encender el interruptor.
-- Precios de olivia_config: Claude Haiku 5.5 (claude-haiku-5-5), USD 0,10 entrada / 0,50 salida por millón de tokens (hasta 100K de prompt).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Configuración
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.olivia_config (
    singleton             boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    enabled               boolean       NOT NULL DEFAULT false,
    daily_limit           integer       NOT NULL DEFAULT 3 CHECK (daily_limit > 0),
    monthly_budget_usd    numeric(8,2)  NOT NULL DEFAULT 5.00 CHECK (monthly_budget_usd >= 0),
    model                 text          NOT NULL DEFAULT 'claude-haiku-5-5',
    input_usd_per_mtok    numeric(8,4)  NOT NULL DEFAULT 0.10 CHECK (input_usd_per_mtok >= 0),
    output_usd_per_mtok   numeric(8,4)  NOT NULL DEFAULT 0.50 CHECK (output_usd_per_mtok >= 0),
    per_query_reserve_usd numeric(8,4)  NOT NULL DEFAULT 0.005 CHECK (per_query_reserve_usd >= 0),
    updated_at            timestamptz   NOT NULL DEFAULT now()
);
INSERT INTO public.olivia_config (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.olivia_config ENABLE ROW LEVEL SECURITY;
-- Supabase da a service_role todos los privilegios en tablas nuevas: se quita lo que sobra.
REVOKE ALL ON public.olivia_config FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE ON public.olivia_config TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Consultas (tope diario y gasto mensual)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.olivia_usage (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    day           date        NOT NULL,
    status        text        NOT NULL DEFAULT 'reservada' CHECK (status IN ('reservada', 'ok', 'fallida')),
    input_tokens  integer     NOT NULL DEFAULT 0,
    output_tokens integer     NOT NULL DEFAULT 0,
    cost_usd      numeric(10,6) NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS olivia_usage_user_day_idx ON public.olivia_usage (user_id, day);
CREATE INDEX IF NOT EXISTS olivia_usage_created_idx  ON public.olivia_usage (created_at);

ALTER TABLE public.olivia_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.olivia_usage FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.olivia_usage TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Copias del día
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.olivia_snapshots (
    day      date        NOT NULL,
    kind     text        NOT NULL CHECK (kind IN ('offer', 'venues', 'weather')),
    payload  jsonb       NOT NULL,
    built_at timestamptz NOT NULL DEFAULT now(),
    stale    boolean     NOT NULL DEFAULT false,
    PRIMARY KEY (day, kind)
);

ALTER TABLE public.olivia_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.olivia_snapshots FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.olivia_snapshots TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Funciones
-- ---------------------------------------------------------------------------------------------------------------------

-- Día calendario de Santiago de un instante.
CREATE OR REPLACE FUNCTION public.olivia_day(p_at timestamptz DEFAULT now())
RETURNS date LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT (p_at AT TIME ZONE 'America/Santiago')::date
$$;

-- Próxima medianoche de Santiago (cuándo se reinicia el tope diario).
CREATE OR REPLACE FUNCTION public.olivia_next_reset(p_at timestamptz DEFAULT now())
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT ((public.olivia_day(p_at) + 1)::timestamp) AT TIME ZONE 'America/Santiago'
$$;

-- Una consulta cuenta si terminó bien, o si está en vuelo hace menos de 3 minutos.
CREATE OR REPLACE FUNCTION public.olivia_used_today(p_user uuid, p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT count(*)::int FROM public.olivia_usage u
     WHERE u.user_id = p_user AND u.day = public.olivia_day(p_now)
       AND (u.status = 'ok' OR (u.status = 'reservada' AND u.created_at > p_now - interval '3 minutes'))
$$;

-- Gasto del mes de Santiago: consultas terminadas + la reserva de las que están en vuelo.
CREATE OR REPLACE FUNCTION public.olivia_month_spend(p_now timestamptz DEFAULT now())
RETURNS numeric LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT COALESCE(sum(CASE WHEN u.status = 'ok' THEN u.cost_usd ELSE (SELECT per_query_reserve_usd FROM public.olivia_config LIMIT 1) END), 0)
      FROM public.olivia_usage u
     WHERE date_trunc('month', u.day::timestamp) = date_trunc('month', public.olivia_day(p_now)::timestamp)
       AND (u.status = 'ok' OR (u.status = 'reservada' AND u.created_at > p_now - interval '3 minutes'))
$$;

-- Lo que ve el cliente: interruptor, tope, usadas, restantes y cuándo se reinicia.
CREATE OR REPLACE FUNCTION public.olivia_usage(p_user uuid, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
    cfg  public.olivia_config%ROWTYPE;
    used integer;
BEGIN
    SELECT * INTO cfg FROM public.olivia_config LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('enabled', false, 'daily_limit', 0, 'used', 0, 'remaining', 0, 'resets_at', public.olivia_next_reset(p_now), 'budget_exhausted', false);
    END IF;
    used := CASE WHEN p_user IS NULL THEN 0 ELSE public.olivia_used_today(p_user, p_now) END;
    RETURN jsonb_build_object(
        'enabled', cfg.enabled,
        'daily_limit', cfg.daily_limit,
        'used', used,
        'remaining', GREATEST(cfg.daily_limit - used, 0),
        'resets_at', public.olivia_next_reset(p_now),
        'budget_exhausted', (public.olivia_month_spend(p_now) + cfg.per_query_reserve_usd) > cfg.monthly_budget_usd
    );
END;
$$;

-- Reserva atómica de una consulta (candado por usuario: dos pestañas no pueden pasarse del tope).
-- Respuesta: { ok, code?, id?, daily_limit, used, remaining, resets_at, model }.
-- code: 'disabled' | 'no_user' | 'limit_reached' | 'budget_exhausted'.
CREATE OR REPLACE FUNCTION public.olivia_reserve(p_user uuid, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    cfg  public.olivia_config%ROWTYPE;
    used integer;
    new_id uuid;
BEGIN
    SELECT * INTO cfg FROM public.olivia_config LIMIT 1;
    IF NOT FOUND OR NOT cfg.enabled THEN
        RETURN jsonb_build_object('ok', false, 'code', 'disabled');
    END IF;
    IF p_user IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'no_user');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('olivia:' || p_user::text, 0));

    used := public.olivia_used_today(p_user, p_now);
    IF used >= cfg.daily_limit THEN
        RETURN jsonb_build_object('ok', false, 'code', 'limit_reached', 'daily_limit', cfg.daily_limit, 'used', used,
                                  'remaining', 0, 'resets_at', public.olivia_next_reset(p_now));
    END IF;

    -- El gasto del mes es global: el candado del tope mensual serializa las reservas entre usuarios.
    PERFORM pg_advisory_xact_lock(hashtextextended('olivia:budget', 0));
    IF (public.olivia_month_spend(p_now) + cfg.per_query_reserve_usd) > cfg.monthly_budget_usd THEN
        RETURN jsonb_build_object('ok', false, 'code', 'budget_exhausted', 'daily_limit', cfg.daily_limit, 'used', used,
                                  'remaining', GREATEST(cfg.daily_limit - used, 0), 'resets_at', public.olivia_next_reset(p_now));
    END IF;

    INSERT INTO public.olivia_usage (user_id, day, status, created_at)
    VALUES (p_user, public.olivia_day(p_now), 'reservada', p_now)
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('ok', true, 'id', new_id, 'daily_limit', cfg.daily_limit, 'used', used + 1,
                              'remaining', GREATEST(cfg.daily_limit - used - 1, 0), 'resets_at', public.olivia_next_reset(p_now),
                              'model', cfg.model);
END;
$$;

-- Cierra la consulta con los tokens reales. 'ok' cuenta y gasta; 'fallida' no cuenta ni gasta.
CREATE OR REPLACE FUNCTION public.olivia_finish(p_id uuid, p_status text, p_input integer DEFAULT 0, p_output integer DEFAULT 0)
RETURNS numeric LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    cfg  public.olivia_config%ROWTYPE;
    cost numeric(10,6) := 0;
BEGIN
    IF p_status NOT IN ('ok', 'fallida') THEN RAISE EXCEPTION 'estado inválido: %', p_status; END IF;
    SELECT * INTO cfg FROM public.olivia_config LIMIT 1;
    IF p_status = 'ok' AND FOUND THEN
        cost := round((GREATEST(p_input, 0) * cfg.input_usd_per_mtok + GREATEST(p_output, 0) * cfg.output_usd_per_mtok) / 1000000.0, 6);
    END IF;
    UPDATE public.olivia_usage
       SET status = p_status, input_tokens = GREATEST(p_input, 0), output_tokens = GREATEST(p_output, 0),
           cost_usd = cost, finished_at = now()
     WHERE id = p_id AND status = 'reservada';
    RETURN cost;
END;
$$;

-- Marca las copias de hoy como desactualizadas (se reconstruyen en la próxima consulta). Nunca bloquea la escritura que la dispara.
CREATE OR REPLACE FUNCTION public.olivia_mark_stale(p_kinds text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    UPDATE public.olivia_snapshots SET stale = true
     WHERE day = public.olivia_day(now()) AND kind = ANY (p_kinds) AND NOT stale;
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.olivia_menu_stale_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM public.olivia_mark_stale(ARRAY['offer']);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.olivia_restaurant_stale_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM public.olivia_mark_stale(ARRAY['offer', 'venues']);
    RETURN NULL;
END;
$$;

-- Platos: solo cuando cambia algo que ve el cliente (no en cada descuento de stock: solo al agotarse o reponerse).
DROP TRIGGER IF EXISTS tr_olivia_stale_menu_iud ON public.menu_items;
CREATE TRIGGER tr_olivia_stale_menu_iud AFTER INSERT OR DELETE ON public.menu_items
    FOR EACH STATEMENT EXECUTE FUNCTION public.olivia_menu_stale_trg();

DROP TRIGGER IF EXISTS tr_olivia_stale_menu_upd ON public.menu_items;
CREATE TRIGGER tr_olivia_stale_menu_upd AFTER UPDATE ON public.menu_items
    FOR EACH ROW WHEN (
        old.name IS DISTINCT FROM new.name OR old.description IS DISTINCT FROM new.description
        OR old.price IS DISTINCT FROM new.price OR old.takeaway_price IS DISTINCT FROM new.takeaway_price
        OR old.category IS DISTINCT FROM new.category OR old.is_available IS DISTINCT FROM new.is_available
        OR old.is_available_for_takeaway IS DISTINCT FROM new.is_available_for_takeaway
        OR old.is_menu_del_dia IS DISTINCT FROM new.is_menu_del_dia OR old.disabled_by_stock IS DISTINCT FROM new.disabled_by_stock
        OR old.stock_managed IS DISTINCT FROM new.stock_managed OR old.restaurant_id IS DISTINCT FROM new.restaurant_id
        OR (old.current_stock > 0) IS DISTINCT FROM (new.current_stock > 0)
    ) EXECUTE FUNCTION public.olivia_menu_stale_trg();

DROP TRIGGER IF EXISTS tr_olivia_stale_restaurant ON public.restaurants;
CREATE TRIGGER tr_olivia_stale_restaurant AFTER UPDATE ON public.restaurants
    FOR EACH ROW WHEN (
        old.name IS DISTINCT FROM new.name OR old.description IS DISTINCT FROM new.description
        OR old.is_active IS DISTINCT FROM new.is_active OR old.plan_hidden IS DISTINCT FROM new.plan_hidden
        OR old.cuisine_type IS DISTINCT FROM new.cuisine_type OR old.price_level IS DISTINCT FROM new.price_level
        OR old.address IS DISTINCT FROM new.address OR old.comuna IS DISTINCT FROM new.comuna
        OR old.lat IS DISTINCT FROM new.lat OR old.lng IS DISTINCT FROM new.lng
        OR old.amenities IS DISTINCT FROM new.amenities OR old.spaces IS DISTINCT FROM new.spaces
        OR old.capacity IS DISTINCT FROM new.capacity OR old.space_capacities IS DISTINCT FROM new.space_capacities
        OR old.opening_hours IS DISTINCT FROM new.opening_hours
        OR old.has_takeaway IS DISTINCT FROM new.has_takeaway OR old.has_reservations IS DISTINCT FROM new.has_reservations
        OR old.average_prep_time IS DISTINCT FROM new.average_prep_time
    ) EXECUTE FUNCTION public.olivia_restaurant_stale_trg();

DROP TRIGGER IF EXISTS tr_olivia_stale_restaurant_id ON public.restaurants;
CREATE TRIGGER tr_olivia_stale_restaurant_id AFTER INSERT OR DELETE ON public.restaurants
    FOR EACH STATEMENT EXECUTE FUNCTION public.olivia_restaurant_stale_trg();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Permisos: nada para anon/authenticated; solo service_role ejecuta.
-- ---------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.olivia_day(timestamptz)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_next_reset(timestamptz)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_used_today(uuid, timestamptz)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_month_spend(timestamptz)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_usage(uuid, timestamptz)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_reserve(uuid, timestamptz)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_finish(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_mark_stale(text[])                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_menu_stale_trg()                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.olivia_restaurant_stale_trg()              FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.olivia_day(timestamptz)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.olivia_next_reset(timestamptz)             TO service_role;
GRANT EXECUTE ON FUNCTION public.olivia_used_today(uuid, timestamptz)       TO service_role;
GRANT EXECUTE ON FUNCTION public.olivia_month_spend(timestamptz)            TO service_role;
GRANT EXECUTE ON FUNCTION public.olivia_usage(uuid, timestamptz)            TO service_role;
GRANT EXECUTE ON FUNCTION public.olivia_reserve(uuid, timestamptz)          TO service_role;
GRANT EXECUTE ON FUNCTION public.olivia_finish(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.olivia_mark_stale(text[])                  TO service_role;
