-- 046_menu_categories.sql
-- Categorías de la carta con orden y visibilidad configurables por el restaurante (Fase 1 de "categorías y opciones").
--
-- Antes: menu_items.category era texto libre (default 'General'), sin orden ni visibilidad.
-- Ahora: tabla menu_categories + menu_items.category_id (FK) + menu_items.position. El texto `category` SE CONSERVA
-- durante la transición: un trigger lo mantiene sincronizado con la categoría (renombrar actualiza los platos) y
-- resuelve/crea la categoría cuando código antiguo escribe solo el texto. Así la migración puede ir ANTES del código.
--
-- Lectura pública (la PWA la usa, igual que menu_items); escritura solo service_role (acciones de servidor del dashboard).
-- Reordenar y eliminar son RPC atómicas, solo service_role.

-- 1) Normalización del nombre: minúsculas, sin tildes, ñ -> n, espacios colapsados (misma idea que nombre_fantasia_norm).
CREATE OR REPLACE FUNCTION public.menu_category_norm(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
    SELECT translate(lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))), 'áéíóúüñ', 'aeiouun');
$$;

-- 2) Tabla de categorías.
CREATE TABLE public.menu_categories (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
    name_norm     text GENERATED ALWAYS AS (public.menu_category_norm(name)) STORED,
    position      integer NOT NULL DEFAULT 0,
    is_visible    boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT menu_categories_restaurant_name_key UNIQUE (restaurant_id, name_norm)
);
CREATE INDEX menu_categories_restaurant_position_idx ON public.menu_categories (restaurant_id, position);

-- 3) Columnas nuevas en menu_items. RESTRICT: una categoría con platos no se borra sin moverlos (ver menu_delete_category).
ALTER TABLE public.menu_items
    ADD COLUMN category_id uuid REFERENCES public.menu_categories(id) ON DELETE RESTRICT,
    ADD COLUMN position integer NOT NULL DEFAULT 0;
CREATE INDEX menu_items_category_position_idx ON public.menu_items (category_id, position);

-- 4) Backfill (antes de crear los triggers). Una categoría por (restaurante, nombre normalizado): sin duplicar por
--    mayúsculas, tildes o espacios; se conserva la grafía más usada. Orden inicial = alfabético (el que ya se mostraba).
--    Los typos reales ("Menúy Especial") NO se corrigen aquí: el administrador los fusiona desde el gestor.
INSERT INTO public.menu_categories (restaurant_id, name, position)
SELECT d.restaurant_id, d.cat,
       (row_number() OVER (PARTITION BY d.restaurant_id ORDER BY d.norm) - 1)::integer
FROM (
    SELECT DISTINCT ON (s.restaurant_id, s.norm) s.restaurant_id, s.norm, s.cat
    FROM (
        SELECT restaurant_id,
               coalesce(nullif(btrim(regexp_replace(category, '\s+', ' ', 'g')), ''), 'General') AS cat,
               public.menu_category_norm(coalesce(nullif(btrim(category), ''), 'General')) AS norm
        FROM public.menu_items
        WHERE restaurant_id IS NOT NULL
    ) s
    GROUP BY s.restaurant_id, s.norm, s.cat
    ORDER BY s.restaurant_id, s.norm, count(*) DESC, s.cat
) d;

UPDATE public.menu_items i
   SET category_id = c.id,
       category = c.name  -- el texto adopta la grafía canónica de la categoría
  FROM public.menu_categories c
 WHERE c.restaurant_id = i.restaurant_id
   AND c.name_norm = public.menu_category_norm(coalesce(nullif(btrim(i.category), ''), 'General'));

UPDATE public.menu_items i
   SET position = r.rn
  FROM (
      SELECT id, (row_number() OVER (PARTITION BY category_id ORDER BY lower(name), id) - 1)::integer AS rn
      FROM public.menu_items WHERE category_id IS NOT NULL
  ) r
 WHERE r.id = i.id;

-- 5) Sincronía categoría <-> texto en menu_items.
--    - category_id nuevo o distinto: manda el id (el texto se copia del nombre de la categoría).
--    - Solo cambió el texto (código antiguo): se resuelve por nombre normalizado y, si no existe, se crea al final.
--    - Un plato que entra a una categoría (alta o cambio) queda al final de ella.
CREATE OR REPLACE FUNCTION public.menu_items_sync_category()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_id    uuid;
    v_name  text;
    v_clean text;
BEGIN
    IF NEW.restaurant_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.category_id IS NOT NULL
       AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id
       AND NEW.category IS NOT DISTINCT FROM OLD.category THEN
        RETURN NEW;  -- ni categoría ni texto cambiaron
    END IF;

    IF NEW.category_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.category_id IS DISTINCT FROM OLD.category_id) THEN
        SELECT name INTO v_name FROM public.menu_categories
         WHERE id = NEW.category_id AND restaurant_id = NEW.restaurant_id;
        IF v_name IS NULL THEN
            RAISE EXCEPTION 'La categoría no pertenece a este restaurante' USING ERRCODE = '23503';
        END IF;
        v_id := NEW.category_id;
    ELSE
        v_clean := coalesce(nullif(btrim(regexp_replace(coalesce(NEW.category, ''), '\s+', ' ', 'g')), ''), 'General');
        SELECT id, name INTO v_id, v_name FROM public.menu_categories
         WHERE restaurant_id = NEW.restaurant_id AND name_norm = public.menu_category_norm(v_clean);
        IF v_id IS NULL THEN
            INSERT INTO public.menu_categories (restaurant_id, name, position)
            VALUES (NEW.restaurant_id, v_clean,
                    coalesce((SELECT max(position) + 1 FROM public.menu_categories WHERE restaurant_id = NEW.restaurant_id), 0))
            ON CONFLICT (restaurant_id, name_norm) DO NOTHING;
            SELECT id, name INTO v_id, v_name FROM public.menu_categories
             WHERE restaurant_id = NEW.restaurant_id AND name_norm = public.menu_category_norm(v_clean);
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR v_id IS DISTINCT FROM OLD.category_id THEN
        NEW.position := coalesce((SELECT max(position) + 1 FROM public.menu_items WHERE category_id = v_id), 0);
    END IF;
    NEW.category_id := v_id;
    NEW.category := v_name;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tr_menu_items_sync_category
    BEFORE INSERT OR UPDATE OF category, category_id ON public.menu_items
    FOR EACH ROW EXECUTE FUNCTION public.menu_items_sync_category();

-- Renombrar una categoría actualiza el texto de sus platos (el texto legado sigue coherente).
CREATE OR REPLACE FUNCTION public.menu_categories_sync_items_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    IF NEW.name IS DISTINCT FROM OLD.name THEN
        UPDATE public.menu_items SET category = NEW.name WHERE category_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tr_menu_categories_sync_items_name
    AFTER UPDATE OF name ON public.menu_categories
    FOR EACH ROW EXECUTE FUNCTION public.menu_categories_sync_items_name();

-- 6) RPC atómicas (solo service_role). Validan que los ids sean exactamente los del restaurante / categoría.
CREATE OR REPLACE FUNCTION public.menu_reorder_categories(p_restaurant uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_n int;
BEGIN
    SELECT count(*) INTO v_n FROM public.menu_categories WHERE restaurant_id = p_restaurant;
    IF coalesce(cardinality(p_ids), 0) <> v_n
       OR (SELECT count(DISTINCT i) FROM unnest(p_ids) i) <> v_n
       OR EXISTS (SELECT 1 FROM unnest(p_ids) i
                   WHERE NOT EXISTS (SELECT 1 FROM public.menu_categories c WHERE c.id = i AND c.restaurant_id = p_restaurant)) THEN
        RAISE EXCEPTION 'Las categorías cambiaron; recarga la carta e intenta de nuevo' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.menu_categories c SET position = (u.ord - 1)::integer
      FROM unnest(p_ids) WITH ORDINALITY AS u(id, ord)
     WHERE c.id = u.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.menu_reorder_items(p_category uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_n int;
BEGIN
    SELECT count(*) INTO v_n FROM public.menu_items WHERE category_id = p_category;
    IF coalesce(cardinality(p_ids), 0) <> v_n
       OR (SELECT count(DISTINCT i) FROM unnest(p_ids) i) <> v_n
       OR EXISTS (SELECT 1 FROM unnest(p_ids) i
                   WHERE NOT EXISTS (SELECT 1 FROM public.menu_items m WHERE m.id = i AND m.category_id = p_category)) THEN
        RAISE EXCEPTION 'Los platos cambiaron; recarga la carta e intenta de nuevo' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.menu_items m SET position = (u.ord - 1)::integer
      FROM unnest(p_ids) WITH ORDINALITY AS u(id, ord)
     WHERE m.id = u.id;
END;
$$;

-- Elimina una categoría. Con platos exige destino (p_move_to, del mismo restaurante): los platos se mueven al final de él.
CREATE OR REPLACE FUNCTION public.menu_delete_category(p_category uuid, p_move_to uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_rest uuid;
BEGIN
    SELECT restaurant_id INTO v_rest FROM public.menu_categories WHERE id = p_category;
    IF v_rest IS NULL THEN
        RAISE EXCEPTION 'La categoría no existe' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.menu_items WHERE category_id = p_category) THEN
        IF p_move_to IS NULL OR p_move_to = p_category
           OR NOT EXISTS (SELECT 1 FROM public.menu_categories WHERE id = p_move_to AND restaurant_id = v_rest) THEN
            RAISE EXCEPTION 'La categoría tiene platos: elige a qué categoría moverlos' USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.menu_items SET category_id = p_move_to WHERE category_id = p_category;
    END IF;
    DELETE FROM public.menu_categories WHERE id = p_category;
END;
$$;

-- 7) Permisos mínimos (GRANT explícito + REVOKE de lo que Supabase da de más).
ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Menu categories are viewable by everyone."
    ON public.menu_categories FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON public.menu_categories FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.menu_categories TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.menu_categories TO service_role;

REVOKE ALL ON FUNCTION public.menu_items_sync_category() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menu_categories_sync_items_name() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menu_reorder_categories(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menu_reorder_items(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menu_delete_category(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.menu_reorder_categories(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.menu_reorder_items(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.menu_delete_category(uuid, uuid) TO service_role;
