-- 008: MODULO DE INVENTARIO (menu + stock) — unica fuente de verdad del stock.
--
-- Reemplaza/absorbe la migracion 006 (que nunca se aplico y se elimino del repo): las columnas
-- daily_initial_stock y stock_reset_date se crean aqui.
-- NO APLICADA. Requiere confirmacion explicita antes de correr contra produccion
-- (CLAUDE.md sec. 6) y prueba previa en una branch de Supabase.
-- ROLLBACK: restaurar 007_takeaway_inventory_trigger_reference.sql y luego ejecutar el bloque
-- "ROLLBACK" al final de este archivo.
--
-- Verificado contra produccion (kqanordhsmbtcwtjtrme) el 2026-09-29:
--   * estados validos de takeaway_orders (CHECK): CREADA, PENDIENTE, APROBADA, RECHAZADA, PREPARANDO,
--     LISTO, ENTREGADO, COMPLETADO, CANCELADO, NO_RETIRADO. 'ANULADO' y 'NO SHOW' NO existen en la base
--     (el no-show es NO_RETIRADO).
--   * el trigger vigente no era SECURITY DEFINER y menu_items tiene RLS solo con SELECT: en pedidos
--     hechos por un cliente el UPDATE de stock podia afectar 0 filas en silencio.
--
-- REGLAS DE NEGOCIO
--   1. Al pasar a APROBADA (INSERT ya aprobado por tr_auto_approve, o UPDATE): descuento total del pedido.
--   2. Devolucion SOLO en APROBADA -> RECHAZADA | CANCELADO | ANULADO. Desde PREPARANDO o posterior
--      (LISTO, ENTREGADO, NO_RETIRADO...) NO se devuelve: el plato se considera consumido.
--   3. Devuelve exactamente lo descontado segun el ledger (no segun el JSON del pedido).
--   4. Toda variacion de current_stock queda en inventory_movements (ledger inmutable).
--   5. Guard de sobreventa atomico en el servidor: no hay GREATEST(0, ...) ni descuento silencioso.
--   6. Reactivacion automatica solo si el sistema apago el item por stock (disabled_by_stock).

-- ============================================================================
-- 1. Columnas nuevas en menu_items (ALTER: no aplica GRANT nuevo)
-- ============================================================================
ALTER TABLE public.menu_items
    ADD COLUMN IF NOT EXISTS daily_initial_stock integer,
    ADD COLUMN IF NOT EXISTS stock_reset_date date,
    ADD COLUMN IF NOT EXISTS disabled_by_stock boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.menu_items.daily_initial_stock IS 'Stock inicial cargado para el dia (una vez por dia). Solo via inventory_set_daily_initial.';
COMMENT ON COLUMN public.menu_items.stock_reset_date IS 'Fecha (America/Santiago) de la ultima carga de stock inicial.';
COMMENT ON COLUMN public.menu_items.disabled_by_stock IS 'true = el SISTEMA apago el item por stock 0; solo estos se reactivan solos. Un apagado manual del admin lo deja en false.';

-- Backfill (mejor esfuerzo): items ya agotados y apagados. En produccion, 2026-09-29: 0 filas.
UPDATE public.menu_items
   SET disabled_by_stock = true
 WHERE stock_managed = true
   AND COALESCE(current_stock, 0) <= 0
   AND is_available IS FALSE;

-- ============================================================================
-- 2. Ledger: inventory_movements (tabla NUEVA => GRANT explicito, CLAUDE.md sec. 6)
-- ============================================================================
-- menu_item_id / order_id sin FK a proposito: el ledger es inmutable y debe sobrevivir al borrado
-- de un plato o pedido; por eso guarda item_name como snapshot.
CREATE TABLE IF NOT EXISTS public.inventory_movements (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    menu_item_id  uuid        NOT NULL,
    item_name     text        NOT NULL,
    restaurant_id uuid,
    order_id      uuid,
    delta         integer     NOT NULL,
    stock_before  integer     NOT NULL,
    stock_after   integer     NOT NULL,
    reason        text        NOT NULL,
    actor_id      uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inventory_movements_reason_check
        CHECK (reason IN ('ORDER_APPROVED','ORDER_RETURNED','MANUAL_INCREASE','MANUAL_DECREASE','DAILY_INITIAL')),
    CONSTRAINT inventory_movements_balance_check CHECK (stock_after = stock_before + delta),
    CONSTRAINT inventory_movements_nonneg_check  CHECK (stock_before >= 0 AND stock_after >= 0),
    CONSTRAINT inventory_movements_delta_check   CHECK (delta <> 0 OR reason = 'DAILY_INITIAL'),
    CONSTRAINT inventory_movements_order_check   CHECK (order_id IS NULL OR reason IN ('ORDER_APPROVED','ORDER_RETURNED'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON public.inventory_movements (menu_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_restaurant ON public.inventory_movements (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_order ON public.inventory_movements (order_id) WHERE order_id IS NOT NULL;
-- Idempotencia: una transicion repetida no descuenta ni devuelve dos veces el mismo item del pedido.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movements_order_item_reason
    ON public.inventory_movements (order_id, menu_item_id, reason) WHERE order_id IS NOT NULL;

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
-- Sin policies: solo el rol que bypassea RLS (service_role) y el owner (funciones SECURITY DEFINER) acceden.

-- GRANT explicito, minimo privilegio: escribir solo ocurre dentro de funciones SECURITY DEFINER
-- (owner postgres), asi que service_role solo necesita leer (historial en el dashboard, via server actions).
REVOKE ALL ON TABLE public.inventory_movements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.inventory_movements TO service_role;

CREATE OR REPLACE FUNCTION public.inventory_movements_immutable()
RETURNS trigger LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'inventory_movements es inmutable (solo inserciones)' USING ERRCODE = 'INV06';
END;
$$;

DROP TRIGGER IF EXISTS tr_inventory_movements_immutable ON public.inventory_movements;
CREATE TRIGGER tr_inventory_movements_immutable
    BEFORE UPDATE OR DELETE ON public.inventory_movements
    FOR EACH ROW EXECUTE FUNCTION public.inventory_movements_immutable();

DROP TRIGGER IF EXISTS tr_inventory_movements_no_truncate ON public.inventory_movements;
CREATE TRIGGER tr_inventory_movements_no_truncate
    BEFORE TRUNCATE ON public.inventory_movements
    FOR EACH STATEMENT EXECUTE FUNCTION public.inventory_movements_immutable();

-- ============================================================================
-- 3. Helpers
-- ============================================================================
-- Rol del llamador segun el JWT de PostgREST ('anon' | 'authenticated' | 'service_role'); NULL en SQL directo.
CREATE OR REPLACE FUNCTION public.inventory_caller_role()
RETURNS text LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
        NULLIF(current_setting('request.jwt.claim.role', true), '')
    );
$$;

-- Normaliza pedido.items (jsonb array, o string jsonb doble-codificado) a (item_id, qty) agregado
-- por item y ORDENADO por id (orden de bloqueo estable => sin deadlocks entre pedidos).
-- Contrato heredado del trigger original: id = items[].id o items[].menu_item_id; quantity por defecto 1.
CREATE OR REPLACE FUNCTION public.inventory_items_needed(p_items jsonb)
RETURNS TABLE (item_id uuid, qty integer)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_items jsonb := p_items;
BEGIN
    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'string' THEN
        v_items := (v_items #>> '{}')::jsonb;
    END IF;
    IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT x.iid, SUM(x.q)::integer
    FROM (
        SELECT CASE WHEN COALESCE(t.e->>'id', t.e->>'menu_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN COALESCE(t.e->>'id', t.e->>'menu_item_id')::uuid END AS iid,
               trunc(COALESCE(NULLIF(t.e->>'quantity', '')::numeric, 1))::integer AS q
        FROM jsonb_array_elements(v_items) AS t(e)
    ) x
    WHERE x.iid IS NOT NULL AND x.q > 0
    GROUP BY x.iid
    ORDER BY x.iid;
END;
$$;

-- ============================================================================
-- 4. inventory_move: el UNICO punto que modifica menu_items.current_stock
-- ============================================================================
-- Devuelve el stock resultante, o NULL si no hubo movimiento (item inexistente, sin control de stock,
-- o movimiento de pedido ya registrado = idempotencia).
-- Errores propios: SQLSTATE INV01, mensaje 'SIN_STOCK|<nombre>|<disponible>'.
CREATE OR REPLACE FUNCTION public.inventory_move(
    p_item   uuid,
    p_delta  integer,
    p_reason text,
    p_order  uuid DEFAULT NULL,
    p_actor  uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r        public.menu_items%ROWTYPE;
    v_before integer;
    v_after  integer;
    v_avail  boolean;
    v_dis    boolean;
BEGIN
    IF p_reason NOT IN ('ORDER_APPROVED','ORDER_RETURNED','MANUAL_INCREASE','MANUAL_DECREASE','DAILY_INITIAL') THEN
        RAISE EXCEPTION 'INVENTORY_BAD_REASON|%', p_reason;
    END IF;

    SELECT * INTO r FROM public.menu_items WHERE id = p_item FOR UPDATE;
    IF NOT FOUND OR r.stock_managed IS NOT TRUE THEN
        RETURN NULL;
    END IF;

    IF p_order IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.inventory_movements
         WHERE order_id = p_order AND menu_item_id = p_item AND reason = p_reason
    ) THEN
        RETURN NULL;
    END IF;

    v_before := GREATEST(0, COALESCE(r.current_stock, 0));
    v_after  := v_before + p_delta;

    IF v_after < 0 THEN
        RAISE EXCEPTION 'SIN_STOCK|%|%', r.name, v_before
            USING ERRCODE = 'INV01', DETAIL = format('item_id=%s solicitado=%s', p_item, -p_delta);
    END IF;

    IF p_delta = 0 AND p_reason <> 'DAILY_INITIAL' THEN
        RETURN v_before;
    END IF;

    v_avail := r.is_available;
    v_dis   := r.disabled_by_stock;

    IF p_delta < 0 AND v_after = 0 AND COALESCE(r.is_available, true) THEN
        -- El sistema agota el item: lo apaga y lo marca como apagado por stock.
        v_avail := false;
        v_dis   := true;
    ELSIF v_before = 0 AND v_after > 0 AND r.disabled_by_stock
          AND p_reason IN ('ORDER_RETURNED','MANUAL_INCREASE','DAILY_INITIAL') THEN
        -- Solo se reactiva lo que el sistema apago. Un apagado manual (disabled_by_stock = false) se respeta.
        v_avail := true;
        v_dis   := false;
    END IF;

    PERFORM set_config('inventory.internal', 'on', true);
    UPDATE public.menu_items
       SET current_stock     = v_after,
           is_available      = v_avail,
           disabled_by_stock = v_dis,
           updated_at        = now()
     WHERE id = p_item;
    PERFORM set_config('inventory.internal', 'off', true);

    INSERT INTO public.inventory_movements
        (menu_item_id, item_name, restaurant_id, order_id, delta, stock_before, stock_after, reason, actor_id)
    VALUES
        (p_item, r.name, r.restaurant_id, p_order, p_delta, v_before, v_after, p_reason, p_actor);

    RETURN v_after;
END;
$$;

-- ============================================================================
-- 5. Guard sobre menu_items: current_stock & co. solo cambian via inventory_move
-- ============================================================================
CREATE OR REPLACE FUNCTION public.menu_items_inventory_guard()
RETURNS trigger LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('inventory.internal', true) IS DISTINCT FROM 'on' THEN
        IF NEW.current_stock       IS DISTINCT FROM OLD.current_stock
        OR NEW.daily_initial_stock IS DISTINCT FROM OLD.daily_initial_stock
        OR NEW.stock_reset_date    IS DISTINCT FROM OLD.stock_reset_date
        OR NEW.disabled_by_stock   IS DISTINCT FROM OLD.disabled_by_stock THEN
            RAISE EXCEPTION 'El stock solo se modifica mediante el modulo de inventario (inventory_* RPC)'
                USING ERRCODE = 'INV02';
        END IF;
        -- Cambio manual de disponibilidad: el control del administrador siempre gana sobre la marca automatica.
        IF NEW.is_available IS DISTINCT FROM OLD.is_available THEN
            NEW.disabled_by_stock := false;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_menu_items_inventory_guard ON public.menu_items;
CREATE TRIGGER tr_menu_items_inventory_guard
    BEFORE UPDATE ON public.menu_items
    FOR EACH ROW EXECUTE FUNCTION public.menu_items_inventory_guard();

-- ============================================================================
-- 6. Descuento / devolucion de un pedido completo
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_apply_order(p_order uuid, p_items jsonb, p_actor uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT * FROM public.inventory_items_needed(p_items) LOOP
        PERFORM public.inventory_move(r.item_id, -r.qty, 'ORDER_APPROVED', p_order, p_actor);
    END LOOP;
END;
$$;

-- Devuelve exactamente lo que el ledger registra como descontado para ese pedido y aun no devuelto.
CREATE OR REPLACE FUNCTION public.inventory_return_order(p_order uuid, p_actor uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT menu_item_id, -SUM(delta)::integer AS qty
          FROM public.inventory_movements
         WHERE order_id = p_order AND reason = 'ORDER_APPROVED'
         GROUP BY menu_item_id
         ORDER BY menu_item_id
    LOOP
        IF r.qty > 0 THEN
            PERFORM public.inventory_move(r.menu_item_id, r.qty, 'ORDER_RETURNED', p_order, p_actor);
        END IF;
    END LOOP;
END;
$$;

-- ============================================================================
-- 7. Triggers sobre takeaway_orders
-- ============================================================================
-- 7a. handle_takeaway_inventory: delgado, solo decide por transicion de estado.
CREATE OR REPLACE FUNCTION public.handle_takeaway_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'APROBADA' THEN
            PERFORM public.inventory_apply_order(NEW.id, NEW.items, auth.uid());
        END IF;
    ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
        IF NEW.status = 'APROBADA' THEN
            PERFORM public.inventory_apply_order(NEW.id, NEW.items, auth.uid());
        -- Devolucion solo si el pedido NO entro a cocina (estaba APROBADA). PREPARANDO o posterior = consumido.
        -- 'ANULADO' no esta hoy en el CHECK de status; se deja por si se agrega.
        ELSIF OLD.status = 'APROBADA' AND NEW.status IN ('RECHAZADA','CANCELADO','ANULADO') THEN
            PERFORM public.inventory_return_order(NEW.id, auth.uid());
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_handle_takeaway_inventory ON public.takeaway_orders;
CREATE TRIGGER tr_handle_takeaway_inventory
    AFTER INSERT OR UPDATE ON public.takeaway_orders
    FOR EACH ROW EXECUTE FUNCTION public.handle_takeaway_inventory();

-- 7b. Guard de sobreventa (BEFORE INSERT). El nombre 'tr_00_...' se ordena ANTES de
-- tr_auto_approve_takeaway_order (los triggers BEFORE se disparan por orden alfabetico).
-- Bloquea las filas de menu_items (FOR UPDATE, por id) hasta el fin de la transaccion, de modo que
-- el descuento del AFTER INSERT (auto-aprobacion) ocurre con el stock ya validado y sin carreras.
CREATE OR REPLACE FUNCTION public.inventory_guard_takeaway_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r       record;
    v_name  text;
    v_stock integer;
BEGIN
    -- Un cliente (JWT anon/authenticated) solo puede crear pedidos nuevos; la aprobacion es del sistema.
    IF public.inventory_caller_role() IN ('anon','authenticated') AND NEW.status NOT IN ('CREADA','PENDIENTE') THEN
        RAISE EXCEPTION 'Estado inicial no permitido para el cliente: %', NEW.status USING ERRCODE = 'INV03';
    END IF;

    IF NEW.status NOT IN ('CREADA','PENDIENTE','APROBADA') THEN
        RETURN NEW;
    END IF;

    FOR r IN SELECT * FROM public.inventory_items_needed(NEW.items) LOOP
        SELECT m.name, COALESCE(m.current_stock, 0) INTO v_name, v_stock
          FROM public.menu_items m
         WHERE m.id = r.item_id AND m.stock_managed IS TRUE
         FOR UPDATE;
        IF FOUND AND v_stock < r.qty THEN
            RAISE EXCEPTION 'SIN_STOCK|%|%', v_name, GREATEST(0, v_stock)
                USING ERRCODE = 'INV01', DETAIL = format('item_id=%s solicitado=%s', r.item_id, r.qty);
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_00_inventory_guard ON public.takeaway_orders;
CREATE TRIGGER tr_00_inventory_guard
    BEFORE INSERT ON public.takeaway_orders
    FOR EACH ROW EXECUTE FUNCTION public.inventory_guard_takeaway_insert();

-- 7c. Transiciones validas para un CLIENTE (JWT anon/authenticated). Personal y servidor (service_role)
-- no se ven afectados. Permitido al cliente: cancelar (CREADA/PENDIENTE/APROBADA -> CANCELADO) y notificar
-- retiro (APROBADA/PREPARANDO/LISTO -> ENTREGADO, flujo existente de la PWA). Nunca items/total/dueño.
CREATE OR REPLACE FUNCTION public.takeaway_orders_client_guard()
RETURNS trigger LANGUAGE plpgsql
AS $$
BEGIN
    IF public.inventory_caller_role() IN ('anon','authenticated') THEN
        IF NEW.items         IS DISTINCT FROM OLD.items
        OR NEW.total_amount  IS DISTINCT FROM OLD.total_amount
        OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
        OR NEW.user_id       IS DISTINCT FROM OLD.user_id THEN
            RAISE EXCEPTION 'El cliente no puede modificar items, total, restaurante ni dueno del pedido'
                USING ERRCODE = 'INV04';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
               (NEW.status = 'CANCELADO' AND OLD.status IN ('CREADA','PENDIENTE','APROBADA'))
            OR (NEW.status = 'ENTREGADO' AND OLD.status IN ('APROBADA','PREPARANDO','LISTO'))
        ) THEN
            RAISE EXCEPTION 'Transicion no permitida para el cliente: % -> %', OLD.status, NEW.status
                USING ERRCODE = 'INV05';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_takeaway_orders_client_guard ON public.takeaway_orders;
CREATE TRIGGER tr_takeaway_orders_client_guard
    BEFORE UPDATE ON public.takeaway_orders
    FOR EACH ROW EXECUTE FUNCTION public.takeaway_orders_client_guard();

-- ============================================================================
-- 8. RPCs del modulo (los llama el servidor con service_role; la app valida permisos por restaurante
--    antes, igual que transition_status). Devuelven jsonb {success, ...} para errores de negocio.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_set_daily_initial(p_item uuid, p_qty integer, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r       public.menu_items%ROWTYPE;
    v_today date := (now() AT TIME ZONE 'America/Santiago')::date;
    v_before integer;
BEGIN
    IF p_qty IS NULL OR p_qty < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'La cantidad debe ser un entero mayor o igual a 0');
    END IF;
    SELECT * INTO r FROM public.menu_items WHERE id = p_item FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Menu item not found');
    END IF;
    IF r.stock_managed IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'El producto no tiene control de stock activo');
    END IF;
    IF r.stock_reset_date = v_today THEN
        RETURN jsonb_build_object('success', false, 'error', 'El stock inicial de hoy ya fue cargado');
    END IF;

    v_before := GREATEST(0, COALESCE(r.current_stock, 0));
    PERFORM public.inventory_move(p_item, p_qty - v_before, 'DAILY_INITIAL', NULL, p_actor);

    PERFORM set_config('inventory.internal', 'on', true);
    UPDATE public.menu_items
       SET daily_initial_stock = p_qty, stock_reset_date = v_today
     WHERE id = p_item;
    PERFORM set_config('inventory.internal', 'off', true);

    SELECT * INTO r FROM public.menu_items WHERE id = p_item;
    RETURN jsonb_build_object('success', true, 'current_stock', r.current_stock,
        'daily_initial_stock', r.daily_initial_stock, 'stock_reset_date', r.stock_reset_date,
        'is_available', r.is_available, 'disabled_by_stock', r.disabled_by_stock);
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_adjust(p_item uuid, p_type text, p_qty integer, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r        public.menu_items%ROWTYPE;
    v_before integer;
BEGIN
    IF p_type NOT IN ('increase','decrease') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Tipo de ajuste invalido');
    END IF;
    IF p_qty IS NULL OR p_qty <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'La cantidad debe ser un entero mayor a 0');
    END IF;
    SELECT * INTO r FROM public.menu_items WHERE id = p_item FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Menu item not found');
    END IF;
    IF r.stock_managed IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'El producto no tiene control de stock activo');
    END IF;

    v_before := GREATEST(0, COALESCE(r.current_stock, 0));
    IF p_type = 'decrease' AND v_before < p_qty THEN
        RETURN jsonb_build_object('success', false,
            'error', format('Stock insuficiente: hay %s y quieres disminuir %s', v_before, p_qty));
    END IF;

    IF p_type = 'increase' THEN
        PERFORM public.inventory_move(p_item, p_qty, 'MANUAL_INCREASE', NULL, p_actor);
    ELSE
        PERFORM public.inventory_move(p_item, -p_qty, 'MANUAL_DECREASE', NULL, p_actor);
    END IF;

    SELECT * INTO r FROM public.menu_items WHERE id = p_item;
    RETURN jsonb_build_object('success', true, 'current_stock', r.current_stock,
        'is_available', r.is_available, 'disabled_by_stock', r.disabled_by_stock);
END;
$$;

-- Informativa para el toast de la PWA: devuelve los faltantes con el maximo disponible.
-- SECURITY INVOKER: solo lee menu_items, que ya es publico (policy SELECT true). El guard real es el trigger.
CREATE OR REPLACE FUNCTION public.inventory_check_availability(p_items jsonb)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'requested', n.qty,
               'available', GREATEST(0, COALESCE(m.current_stock, 0))
           )), '[]'::jsonb)
      FROM public.inventory_items_needed(p_items) n
      JOIN public.menu_items m ON m.id = n.item_id
     WHERE m.stock_managed IS TRUE AND COALESCE(m.current_stock, 0) < n.qty;
$$;

-- ============================================================================
-- 9. Permisos de ejecucion (por defecto Postgres da EXECUTE a PUBLIC: se revoca explicitamente)
-- ============================================================================
REVOKE ALL ON FUNCTION public.inventory_move(uuid, integer, text, uuid, uuid)             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.inventory_apply_order(uuid, jsonb, uuid)                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.inventory_return_order(uuid, uuid)                          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.handle_takeaway_inventory()                                 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.inventory_guard_takeaway_insert()                           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.takeaway_orders_client_guard()                              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.menu_items_inventory_guard()                                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.inventory_movements_immutable()                             FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.inventory_set_daily_initial(uuid, integer, uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_adjust(uuid, text, integer, uuid)                 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_set_daily_initial(uuid, integer, uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.inventory_adjust(uuid, text, integer, uuid)              TO service_role;

-- Helpers puros / lectura: la PWA (anon/authenticated) los necesita.
GRANT EXECUTE ON FUNCTION public.inventory_caller_role()                                  TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_items_needed(jsonb)                            TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_check_availability(jsonb)                      TO PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- ROLLBACK (ejecutar SOLO si hay que volver atras; despues re-aplicar 007):
--   DROP TRIGGER IF EXISTS tr_00_inventory_guard ON public.takeaway_orders;
--   DROP TRIGGER IF EXISTS tr_takeaway_orders_client_guard ON public.takeaway_orders;
--   DROP TRIGGER IF EXISTS tr_menu_items_inventory_guard ON public.menu_items;
--   -- re-aplicar 007 (restaura handle_takeaway_inventory y su trigger originales)
--   DROP FUNCTION IF EXISTS public.inventory_check_availability(jsonb), public.inventory_adjust(uuid,text,integer,uuid),
--        public.inventory_set_daily_initial(uuid,integer,uuid), public.inventory_return_order(uuid,uuid),
--        public.inventory_apply_order(uuid,jsonb,uuid), public.inventory_move(uuid,integer,text,uuid,uuid),
--        public.inventory_items_needed(jsonb), public.inventory_caller_role(),
--        public.inventory_guard_takeaway_insert(), public.takeaway_orders_client_guard(),
--        public.menu_items_inventory_guard();
--   -- El ledger y las columnas nuevas se conservan (datos historicos); no se borran en rollback.
-- ============================================================================
