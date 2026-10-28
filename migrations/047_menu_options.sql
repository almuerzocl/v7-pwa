-- 047_menu_options.sql
-- Opciones y extras en los platos (Fase 2 de "categorías y opciones") + recálculo de precio en la base.
--
-- Modelo: menu_option_groups (grupo reutilizable por local: nombre, una/varias, obligatorio, mínimo y máximo)
--         menu_options        (opción: nombre, recargo CLP >= 0, disponible, orden)
--         menu_item_option_groups (asignación plato <-> grupo, con el orden de los grupos en ese plato)
-- Lectura pública (la PWA las usa; el recargo no es secreto); escritura solo service_role.
-- El stock sigue siendo del plato: no hay stock por opción (pendiente anotado).
--
-- Precio: el trigger tr_00_c_price_guard (BEFORE INSERT en takeaway_orders) recalcula el precio de cada línea desde la
-- base (precio vigente del plato + recargos de las opciones elegidas), valida las selecciones (opción del plato,
-- disponible, mínimo/máximo/obligatorio) y rechaza el pedido si total_amount no coincide. Reescribe items con el SNAPSHOT
-- de las opciones (nombre y recargo en ese momento): el pedido histórico no cambia si luego se edita o borra la opción.
-- Una sola fuente de verdad para el carrito de la PWA, el pedido manual del dashboard y cualquier INSERT directo.
-- NACE APAGADO (price_enforcement.enabled = false): con el interruptor apagado el trigger no hace nada.

-- 1) Tablas.
CREATE TABLE public.menu_option_groups (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    name_norm     text GENERATED ALWAYS AS (public.menu_category_norm(name)) STORED,
    kind          text NOT NULL DEFAULT 'single' CHECK (kind IN ('single', 'multiple')),
    required      boolean NOT NULL DEFAULT false,
    min_select    integer NOT NULL DEFAULT 0,
    max_select    integer NOT NULL DEFAULT 1,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT menu_option_groups_restaurant_name_key UNIQUE (restaurant_id, name_norm),
    CONSTRAINT menu_option_groups_range CHECK (min_select >= 0 AND max_select >= 1 AND max_select <= 20 AND min_select <= max_select),
    CONSTRAINT menu_option_groups_required CHECK (required = (min_select >= 1)),
    CONSTRAINT menu_option_groups_single CHECK (kind <> 'single' OR max_select = 1)
);
CREATE INDEX menu_option_groups_restaurant_idx ON public.menu_option_groups (restaurant_id);

CREATE TABLE public.menu_options (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     uuid NOT NULL REFERENCES public.menu_option_groups(id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    name_norm    text GENERATED ALWAYS AS (public.menu_category_norm(name)) STORED,
    price_delta  integer NOT NULL DEFAULT 0 CHECK (price_delta >= 0 AND price_delta <= 1000000),
    is_available boolean NOT NULL DEFAULT true,
    position     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT menu_options_group_name_key UNIQUE (group_id, name_norm)
);
CREATE INDEX menu_options_group_position_idx ON public.menu_options (group_id, position);

CREATE TABLE public.menu_item_option_groups (
    item_id  uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
    group_id uuid NOT NULL REFERENCES public.menu_option_groups(id) ON DELETE CASCADE,
    position integer NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, group_id)
);
CREATE INDEX menu_item_option_groups_group_idx ON public.menu_item_option_groups (group_id);

-- Plato y grupo deben ser del mismo restaurante.
CREATE OR REPLACE FUNCTION public.menu_item_option_groups_same_restaurant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    IF (SELECT restaurant_id FROM public.menu_items WHERE id = NEW.item_id)
       IS DISTINCT FROM (SELECT restaurant_id FROM public.menu_option_groups WHERE id = NEW.group_id) THEN
        RAISE EXCEPTION 'El grupo de opciones no pertenece al restaurante del plato' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER tr_menu_item_option_groups_same_restaurant
    BEFORE INSERT OR UPDATE ON public.menu_item_option_groups
    FOR EACH ROW EXECUTE FUNCTION public.menu_item_option_groups_same_restaurant();

-- 2) RPC atómicas (solo service_role).
-- Guarda un grupo COMPLETO de forma atómica: configuración + lista de opciones en su orden.
--   p_group NULL = crear. p_options = [{id?, name, price_delta, is_available}]: las que traen id se actualizan (deben ser del
--   grupo), las nuevas se crean y las que ya no vienen se eliminan (los pedidos guardan snapshot, no se alteran).
--   Los chequeos de rango/obligatorio/nombre los hacen los CHECK de las tablas.
CREATE OR REPLACE FUNCTION public.menu_save_option_group(
    p_restaurant uuid, p_group uuid, p_name text, p_kind text, p_required boolean, p_min integer, p_max integer, p_options jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_id   uuid := p_group;
    v_el   jsonb;
    v_ord  integer := 0;
    v_oid  uuid;
    v_keep uuid[] := '{}';
BEGIN
    IF p_options IS NULL OR jsonb_typeof(p_options) <> 'array' OR jsonb_array_length(p_options) > 50 THEN
        RAISE EXCEPTION 'Las opciones no son válidas (máximo 50)' USING ERRCODE = 'P0001';
    END IF;

    IF v_id IS NULL THEN
        INSERT INTO public.menu_option_groups (restaurant_id, name, kind, required, min_select, max_select)
        VALUES (p_restaurant, btrim(p_name), p_kind, p_required, p_min, p_max) RETURNING id INTO v_id;
    ELSE
        UPDATE public.menu_option_groups
           SET name = btrim(p_name), kind = p_kind, required = p_required, min_select = p_min, max_select = p_max
         WHERE id = v_id AND restaurant_id = p_restaurant;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'El grupo no existe en este restaurante' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- Primero quita las que ya no vienen (evita choques de nombre al reemplazar una por otra).
    FOR v_el IN SELECT e FROM jsonb_array_elements(p_options) AS t(e) LOOP
        IF v_el ->> 'id' IS NOT NULL THEN
            v_keep := v_keep || (v_el ->> 'id')::uuid;
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM unnest(v_keep) k WHERE NOT EXISTS (SELECT 1 FROM public.menu_options o WHERE o.id = k AND o.group_id = v_id)) THEN
        RAISE EXCEPTION 'Las opciones cambiaron; recarga e intenta de nuevo' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.menu_options WHERE group_id = v_id AND NOT (id = ANY (v_keep));

    FOR v_el IN SELECT e FROM jsonb_array_elements(p_options) AS t(e) LOOP
        IF jsonb_typeof(v_el -> 'price_delta') IS DISTINCT FROM 'number' OR (v_el ->> 'price_delta') !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'El recargo debe ser un entero de 0 o más' USING ERRCODE = 'P0001';
        END IF;
        IF v_el ->> 'id' IS NOT NULL THEN
            UPDATE public.menu_options
               SET name = btrim(v_el ->> 'name'), price_delta = (v_el ->> 'price_delta')::integer,
                   is_available = coalesce((v_el ->> 'is_available')::boolean, true), position = v_ord
             WHERE id = (v_el ->> 'id')::uuid;
        ELSE
            INSERT INTO public.menu_options (group_id, name, price_delta, is_available, position)
            VALUES (v_id, btrim(v_el ->> 'name'), (v_el ->> 'price_delta')::integer, coalesce((v_el ->> 'is_available')::boolean, true), v_ord);
        END IF;
        v_ord := v_ord + 1;
    END LOOP;
    RETURN v_id;
END;
$$;

-- Reemplaza los grupos asignados a un plato (y su orden). Lista vacía = quitar todos.
CREATE OR REPLACE FUNCTION public.menu_set_item_groups(p_item uuid, p_group_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_rest uuid;
BEGIN
    SELECT restaurant_id INTO v_rest FROM public.menu_items WHERE id = p_item;
    IF v_rest IS NULL THEN
        RAISE EXCEPTION 'El plato no existe' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(DISTINCT g) FROM unnest(coalesce(p_group_ids, '{}')) g) <> coalesce(cardinality(p_group_ids), 0)
       OR EXISTS (SELECT 1 FROM unnest(coalesce(p_group_ids, '{}')) g
                   WHERE NOT EXISTS (SELECT 1 FROM public.menu_option_groups x WHERE x.id = g AND x.restaurant_id = v_rest)) THEN
        RAISE EXCEPTION 'Los grupos no son válidos para este plato' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.menu_item_option_groups WHERE item_id = p_item;
    INSERT INTO public.menu_item_option_groups (item_id, group_id, position)
    SELECT p_item, u.g, (u.ord - 1)::integer FROM unnest(coalesce(p_group_ids, '{}')) WITH ORDINALITY AS u(g, ord);
END;
$$;

-- 3) Interruptor global del recálculo de precio (nace apagado).
CREATE TABLE public.price_enforcement (
    id      boolean PRIMARY KEY DEFAULT true CHECK (id),
    enabled boolean NOT NULL DEFAULT false
);
INSERT INTO public.price_enforcement (id, enabled) VALUES (true, false);

-- 4) Recalculo y validacion del precio del pedido.
--    Entrada por línea de items: { id, quantity, options: [ {option_id} | "<uuid>" ], ... }.
--    Errores: SQLSTATE PR001, HINT = código estable, DETAIL = JSON (en price_mismatch: { expected_total, items }).
CREATE OR REPLACE FUNCTION public.takeaway_price_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_enabled boolean;
    v_items   jsonb := NEW.items;
    v_out     jsonb := '[]'::jsonb;
    v_total   bigint := 0;
    v_line    jsonb;
    v_el      jsonb;
    v_txt     text;
    v_id      uuid;
    v_qty     integer;
    v_m       record;
    v_o       record;
    v_g       record;
    v_base    integer;
    v_unit    bigint;
    v_ids     uuid[];
    v_oid     uuid;
    v_snap    jsonb;
    v_cnt     integer;
    v_uuid    constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
    SELECT enabled INTO v_enabled FROM public.price_enforcement LIMIT 1;
    IF NOT coalesce(v_enabled, false) THEN
        RETURN NEW;
    END IF;

    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'string' THEN
        v_items := (v_items #>> '{}')::jsonb;
    END IF;
    IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
        RAISE EXCEPTION 'El pedido no tiene platos' USING ERRCODE = 'PR001', HINT = 'empty_order';
    END IF;

    FOR v_line IN SELECT e FROM jsonb_array_elements(v_items) AS t(e) LOOP
        v_txt := coalesce(v_line ->> 'id', v_line ->> 'menu_item_id');
        IF v_txt IS NULL OR v_txt !~* v_uuid THEN
            RAISE EXCEPTION 'Hay un plato no válido en el pedido' USING ERRCODE = 'PR001', HINT = 'item_not_found';
        END IF;
        v_id := v_txt::uuid;
        SELECT m.id, m.name, m.price, m.takeaway_price INTO v_m
          FROM public.menu_items m WHERE m.id = v_id AND m.restaurant_id = NEW.restaurant_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Hay un plato que no pertenece a este restaurante' USING ERRCODE = 'PR001', HINT = 'item_not_found';
        END IF;

        v_txt := v_line ->> 'quantity';
        IF v_txt IS NULL OR v_txt !~ '^[0-9]{1,3}$' OR v_txt::integer < 1 OR v_txt::integer > 100 THEN
            RAISE EXCEPTION 'La cantidad de "%" no es válida', v_m.name USING ERRCODE = 'PR001', HINT = 'invalid_quantity';
        END IF;
        v_qty := v_txt::integer;
        v_base := coalesce(nullif(v_m.takeaway_price, 0), v_m.price);

        -- Selecciones: ids de opción, sin repetir.
        v_ids := '{}';
        IF v_line ? 'options' AND jsonb_typeof(v_line -> 'options') = 'array' THEN
            FOR v_el IN SELECT e FROM jsonb_array_elements(v_line -> 'options') AS t(e) LOOP
                v_txt := CASE WHEN jsonb_typeof(v_el) = 'string' THEN v_el #>> '{}' ELSE coalesce(v_el ->> 'option_id', v_el ->> 'id') END;
                IF v_txt IS NULL OR v_txt !~* v_uuid THEN
                    RAISE EXCEPTION 'Hay una opción no válida en "%"', v_m.name USING ERRCODE = 'PR001', HINT = 'option_invalid';
                END IF;
                v_oid := v_txt::uuid;
                IF v_oid = ANY (v_ids) THEN
                    RAISE EXCEPTION 'Elegiste dos veces la misma opción en "%"', v_m.name USING ERRCODE = 'PR001', HINT = 'option_duplicate';
                END IF;
                v_ids := v_ids || v_oid;
            END LOOP;
        ELSIF v_line ? 'options' AND jsonb_typeof(v_line -> 'options') NOT IN ('array', 'null') THEN
            RAISE EXCEPTION 'Las opciones de "%" no son válidas', v_m.name USING ERRCODE = 'PR001', HINT = 'option_invalid';
        END IF;

        -- Cada opción debe ser de un grupo asignado a ESTE plato y estar disponible (en el orden en que se eligieron).
        v_unit := v_base;
        FOREACH v_oid IN ARRAY v_ids LOOP
            SELECT o.name AS oname, o.price_delta, o.is_available INTO v_o
              FROM public.menu_options o
              JOIN public.menu_item_option_groups ig ON ig.group_id = o.group_id AND ig.item_id = v_id
             WHERE o.id = v_oid;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Una opción elegida no corresponde a "%"', v_m.name USING ERRCODE = 'PR001', HINT = 'option_invalid';
            END IF;
            IF NOT v_o.is_available THEN
                RAISE EXCEPTION 'La opción "%" ya no está disponible', v_o.oname USING ERRCODE = 'PR001', HINT = 'option_unavailable';
            END IF;
            v_unit := v_unit + v_o.price_delta;
        END LOOP;

        -- Mínimo / máximo / obligatorio por grupo asignado.
        FOR v_g IN
            SELECT g.id, g.name, g.min_select, g.max_select
              FROM public.menu_item_option_groups ig JOIN public.menu_option_groups g ON g.id = ig.group_id
             WHERE ig.item_id = v_id ORDER BY ig.position, g.name
        LOOP
            SELECT count(*) INTO v_cnt FROM public.menu_options o WHERE o.group_id = v_g.id AND o.id = ANY (v_ids);
            IF v_cnt > v_g.max_select THEN
                RAISE EXCEPTION 'En "%" puedes elegir hasta % de "%"', v_m.name, v_g.max_select, v_g.name USING ERRCODE = 'PR001', HINT = 'option_max';
            END IF;
            IF v_cnt < v_g.min_select THEN
                RAISE EXCEPTION 'En "%" debes elegir al menos % de "%"', v_m.name, v_g.min_select, v_g.name USING ERRCODE = 'PR001', HINT = 'option_min';
            END IF;
        END LOOP;

        -- Snapshot ordenado: orden de los grupos del plato y de las opciones dentro de cada grupo.
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'option_id', o.id, 'group_id', g.id, 'group_name', g.name, 'name', o.name, 'price_delta', o.price_delta)
               ORDER BY ig.position, g.name, o.position, o.name), '[]'::jsonb)
          INTO v_snap
          FROM public.menu_options o
          JOIN public.menu_option_groups g ON g.id = o.group_id
          JOIN public.menu_item_option_groups ig ON ig.group_id = g.id AND ig.item_id = v_id
         WHERE o.id = ANY (v_ids);

        v_total := v_total + v_unit * v_qty;
        v_out := v_out || (v_line || jsonb_build_object(
            'id', v_id, 'name', v_m.name, 'quantity', v_qty,
            'base_price', v_base, 'options', v_snap, 'price', v_unit, 'unit_price', v_unit));
    END LOOP;

    IF NEW.total_amount IS DISTINCT FROM v_total THEN
        RAISE EXCEPTION 'Los precios cambiaron: revisa tu pedido' USING ERRCODE = 'PR001', HINT = 'price_mismatch',
            DETAIL = jsonb_build_object('expected_total', v_total, 'items', v_out)::text;
    END IF;

    NEW.items := v_out;
    RETURN NEW;
END;
$$;

-- Antes de la autoaprobación (que lee total_amount) y del control de stock; después del tope de operaciones.
CREATE TRIGGER tr_00_c_price_guard
    BEFORE INSERT ON public.takeaway_orders
    FOR EACH ROW EXECUTE FUNCTION public.takeaway_price_guard();

-- 5) Permisos mínimos (GRANT explícito + REVOKE de lo que Supabase da de más).
ALTER TABLE public.menu_option_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_item_option_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_enforcement ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Option groups are viewable by everyone." ON public.menu_option_groups FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Options are viewable by everyone." ON public.menu_options FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Item option groups are viewable by everyone." ON public.menu_item_option_groups FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON public.menu_option_groups, public.menu_options, public.menu_item_option_groups, public.price_enforcement
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.menu_option_groups, public.menu_options, public.menu_item_option_groups TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.menu_option_groups, public.menu_options, public.menu_item_option_groups TO service_role;
GRANT SELECT, UPDATE ON public.price_enforcement TO service_role;

REVOKE ALL ON FUNCTION public.menu_item_option_groups_same_restaurant() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.takeaway_price_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menu_save_option_group(uuid, uuid, text, text, boolean, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menu_set_item_groups(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.menu_save_option_group(uuid, uuid, text, text, boolean, integer, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.menu_set_item_groups(uuid, uuid[]) TO service_role;
