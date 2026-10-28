-- Pruebas de 009_takeaway_auto_approve_reputacion.sql contra datos REALES de produccion
-- (kqanordhsmbtcwtjtrme). No deja filas: todo corre en un unico DO y termina con
-- RAISE EXCEPTION, lo que revierte la transaccion completa (pedidos, stock, movimientos,
-- cambios de reputacion y la propia CREATE OR REPLACE FUNCTION). El resultado llega como
-- texto del error 'TEST_REPORT'.
-- Uso: pegar completo en el SQL editor / execute_sql. Requiere que 009 NO este aplicada aun
-- (el caso 0 reproduce el bug con la funcion vieja).
--
-- Este archivo se genera a partir de 009 (el bloque EXECUTE $mig$ es su contenido literal).
-- Datos reales usados (leidos de la base el 2026-09-30):
--   usuario A 9fce9a46-...: takeaway_reputation=100, reservation_reputation=0
--   usuario B 3adb5e10-...: takeaway_reputation=100, reservation_reputation=100
--   restaurante 2729b647-... (min_reputation=80, max_order_amount=150000)
--   item 76eb6411-... (stock_managed, precio 15900)
DO $test$
DECLARE
    uA constant uuid := '9fce9a46-43d8-4d7e-bbc6-5643cc473bc9';
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    item constant uuid := '76eb6411-9cba-4015-99e1-70c6057ea6c0';
    rep text := '';
    o record;
    s0 int; s1 int; mv record;
BEGIN
    SELECT current_stock INTO s0 FROM menu_items WHERE id = item;
    rep := rep || format(E'stock inicial item=%s\n', s0);

    -- Caso 0 (bug, funcion VIEJA): A tiene takeaway=100 pero reservas=0 -> deberia aprobarse por takeaway.
    -- La funcion vieja usa reservas (0) y NO aprueba => reproduce el bug.
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uA, rid, jsonb_build_array(jsonb_build_object('id', item, 'quantity', 1)), 15900, 'TEST0') RETURNING * INTO o;
    rep := rep || format(E'0) funcion vieja, take=100/res=0 -> status=%s (bug si PENDIENTE)\n', o.status);

    -- Aplicar la migracion dentro de la transaccion
    EXECUTE $mig$-- 009: auto_approve_takeaway_order() debe usar la reputacion de TAKEAWAY, no la de reservas.
--
-- Bug: la funcion calculaba v_user_reputation con COALESCE(reservation_reputation, 100).
-- La reputacion aplica por ambito: takeaway -> takeaway_reputation; reservas -> reservation_reputation.
--
-- Regla de negocio (confirmada por el usuario, 2026-09-30):
--   * La reputacion es un atributo de usuarios reales y activos, entre 0 y 100.
--   * Un pedido sin user_id no puede crearse.
--   * Un usuario con reputacion NULL (en CUALQUIER ambito) no puede ejecutar ninguna operacion.
--   * No hay valor por defecto: se elimina el COALESCE(..., 100). NULL se rechaza.
--
-- Base: definicion real de produccion (kqanordhsmbtcwtjtrme) leida con pg_get_functiondef el
-- 2026-09-30. La logica de aprobacion (estado, monto maximo, reputacion minima) no cambia.
-- Sin cambios de permisos/GRANT: CREATE OR REPLACE conserva los existentes.
-- Las validaciones del usuario van ANTES del early-return por falta de takeaway_settings,
-- para que se apliquen en todos los restaurantes.

CREATE OR REPLACE FUNCTION public.auto_approve_takeaway_order()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_settings jsonb;
    v_max_amount numeric;
    v_min_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
BEGIN
    IF NEW.user_id IS NULL THEN
        RAISE EXCEPTION 'takeaway_orders: user_id es obligatorio (toda transaccion requiere identificacion)'
            USING ERRCODE = 'not_null_violation';
    END IF;

    SELECT takeaway_reputation, reservation_reputation
      INTO v_takeaway_reputation, v_reservation_reputation
      FROM public.profiles WHERE id = NEW.user_id;

    IF v_takeaway_reputation IS NULL OR v_reservation_reputation IS NULL
       OR v_takeaway_reputation NOT BETWEEN 0 AND 100
       OR v_reservation_reputation NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'takeaway_orders: el usuario % no tiene reputacion valida (0-100) en todos sus ambitos', NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT takeaway_settings INTO v_settings FROM public.restaurants WHERE id = NEW.restaurant_id;
    IF v_settings IS NULL THEN RETURN NEW; END IF;

    v_max_amount := COALESCE((v_settings->>'max_order_amount')::numeric, 150000);
    v_min_reputation := COALESCE((v_settings->>'min_reputation')::integer, 80);

    IF (NEW.status IN ('PENDIENTE', 'CREADA')) AND NEW.total_amount <= v_max_amount AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;
$mig$;

    -- a) takeaway malo + reservas bueno -> NO se auto-aprueba
    UPDATE profiles SET takeaway_reputation = 50, reservation_reputation = 100 WHERE id = uB;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id', item, 'quantity', 1)), 15900, 'TESTa') RETURNING * INTO o;
    rep := rep || format(E'a) take=50/res=100 -> status=%s approved_at=%s (esperado PENDIENTE/NULL)\n', o.status, o.approved_at);

    -- b) takeaway bueno + reservas malo -> SI se auto-aprueba, stock descontado, movimiento ORDER_APPROVED
    SELECT current_stock INTO s0 FROM menu_items WHERE id = item;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uA, rid, jsonb_build_array(jsonb_build_object('id', item, 'quantity', 2)), 31800, 'TESTb') RETURNING * INTO o;
    SELECT current_stock INTO s1 FROM menu_items WHERE id = item;
    rep := rep || format(E'b) take=100/res=0 -> status=%s approved_at_set=%s stock %s->%s (esperado APROBADA, -2)\n', o.status, o.approved_at IS NOT NULL, s0, s1);
    FOR mv IN SELECT reason, delta, stock_before, stock_after FROM inventory_movements WHERE order_id = o.id LOOP
        rep := rep || format(E'b) movimiento: reason=%s delta=%s %s->%s\n', mv.reason, mv.delta, mv.stock_before, mv.stock_after);
    END LOOP;

    -- c) monto sobre max_order_amount con reputacion buena -> NO se auto-aprueba
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uA, rid, '[]'::jsonb, 150001, 'TESTc') RETURNING * INTO o;
    rep := rep || format(E'c) total=150001 > max 150000, take=100 -> status=%s (esperado PENDIENTE)\n', o.status);

    -- d) user_id NULL -> la base lo rechaza
    BEGIN
        INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
        VALUES (NULL, rid, '[]'::jsonb, 1000, 'TESTd');
        rep := rep || E'd) user_id NULL -> CREADO (FALLA: debio rechazarse)\n';
    EXCEPTION WHEN OTHERS THEN
        rep := rep || format(E'd) user_id NULL -> rechazado (%s: %s)\n', SQLSTATE, SQLERRM);
    END;

    -- e) reputacion NULL en cualquiera de los ambitos -> rechazado
    UPDATE profiles SET takeaway_reputation = NULL, reservation_reputation = 100 WHERE id = uB;
    BEGIN
        INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, '[]'::jsonb, 1000, 'TESTe1');
        rep := rep || E'e1) takeaway_reputation NULL -> CREADO (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'e1) takeaway_reputation NULL -> rechazado (%s)\n', SQLSTATE); END;
    UPDATE profiles SET takeaway_reputation = 100, reservation_reputation = NULL WHERE id = uB;
    BEGIN
        INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, '[]'::jsonb, 1000, 'TESTe2');
        rep := rep || E'e2) reservation_reputation NULL -> CREADO (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'e2) reservation_reputation NULL -> rechazado (%s)\n', SQLSTATE); END;

    RAISE EXCEPTION E'TEST_REPORT (transaccion revertida)\n%', rep;
END
$test$;
