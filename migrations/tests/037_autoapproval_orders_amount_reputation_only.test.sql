-- Prueba de 037_autoapproval_orders_amount_reputation_only.sql contra datos REALES de produccion (kqanordhsmbtcwtjtrme).
-- Un unico DO que termina en RAISE EXCEPTION: revierte todo (filas, cambios en profiles/restaurants y la funcion).
-- El resultado llega como texto del error 'TEST_REPORT'. El bloque $m037$ es copia literal de la migracion.
DO $test$
DECLARE
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    rep text := '';
    o record;
BEGIN
    EXECUTE $m037$CREATE OR REPLACE FUNCTION public.auto_approve_takeaway_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

    v_max_amount := (v_settings->>'max_order_amount')::numeric;
    v_min_reputation := (v_settings->>'min_reputation')::integer;

    -- Sin parametros del restaurante no se aprueba automaticamente (queda PENDIENTE).
    IF v_max_amount IS NULL OR v_min_reputation IS NULL THEN RETURN NEW; END IF;

    -- Los dos criterios son concurrentes.
    IF (NEW.status IN ('PENDIENTE', 'CREADA'))
       AND NEW.total_amount <= v_max_amount
       AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;$m037$;

    UPDATE profiles SET takeaway_reputation = 100, reservation_reputation = 100 WHERE id = uB;
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000, 'min_reputation', 80) WHERE id = rid;

    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1','quantity',2)), 10000, 'P1') RETURNING * INTO o;
    rep := rep || format(E'p1) monto y reputacion ok -> %s (esperado APROBADA)\n', o.status);
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1','quantity',40)), 10000, 'P2') RETURNING * INTO o;
    rep := rep || format(E'p2) 40 unidades (antes pendiente) -> %s (esperado APROBADA)\n', o.status);
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1')), 150000, 'P3') RETURNING * INTO o;
    rep := rep || format(E'p3) monto justo el maximo -> %s (esperado APROBADA)\n', o.status);
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1')), 150001, 'P4') RETURNING * INTO o;
    rep := rep || format(E'p4) monto sobre el maximo -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE profiles SET takeaway_reputation = 80 WHERE id = uB;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1')), 10000, 'P5') RETURNING * INTO o;
    rep := rep || format(E'p5) reputacion justo el minimo -> %s (esperado APROBADA)\n', o.status);
    UPDATE profiles SET takeaway_reputation = 79 WHERE id = uB;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1')), 10000, 'P6') RETURNING * INTO o;
    rep := rep || format(E'p6) reputacion bajo el minimo -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE profiles SET takeaway_reputation = 100 WHERE id = uB;
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('min_reputation', 80) WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1')), 10000, 'P7') RETURNING * INTO o;
    rep := rep || format(E'p7) falta max_order_amount -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000) WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1')), 10000, 'P8') RETURNING * INTO o;
    rep := rep || format(E'p8) falta min_reputation -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000, 'max_items', 3, 'min_reputation', 80) WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1','quantity',9)), 10000, 'P9') RETURNING * INTO o;
    rep := rep || format(E'p9) clave max_items residual (3) ya no frena: 9 unidades -> %s (esperado APROBADA)\n', o.status);
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000, 'min_reputation', 80) WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name, status)
    VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1')), 10000, 'P10', 'ENTREGADO') RETURNING * INTO o;
    rep := rep || format(E'p10) estado que no es PENDIENTE/CREADA no se toca -> %s (esperado ENTREGADO)\n', o.status);

    RAISE EXCEPTION E'TEST_REPORT (transaccion revertida)\n%', rep;
END
$test$;
