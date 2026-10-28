-- Prueba de 022_autoapproval_restaurant_params_only.sql contra datos REALES de produccion
-- (kqanordhsmbtcwtjtrme). Un unico DO que termina en RAISE EXCEPTION: revierte todo (filas, cambios en
-- profiles/restaurants y las funciones). El resultado llega como texto del error 'TEST_REPORT'.
-- Bloques $m022a$ / $m022b$ = copias literales de la migracion.
DO $test$
DECLARE
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    rep text := '';
    o record;
    r record;
BEGIN
    EXECUTE $m022a$CREATE OR REPLACE FUNCTION public.auto_approve_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_settings jsonb;
    v_max_pax integer;
    v_min_reputation integer;
    v_user_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
BEGIN
    IF NEW.organizer_id IS NULL THEN
        RAISE EXCEPTION 'reservations: organizer_id es obligatorio (toda transaccion requiere identificacion)'
            USING ERRCODE = 'not_null_violation';
    END IF;

    SELECT takeaway_reputation, reservation_reputation
      INTO v_takeaway_reputation, v_reservation_reputation
      FROM public.profiles WHERE id = NEW.organizer_id;

    IF v_takeaway_reputation IS NULL OR v_reservation_reputation IS NULL
       OR v_takeaway_reputation NOT BETWEEN 0 AND 100
       OR v_reservation_reputation NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'reservations: el usuario % no tiene reputacion valida (0-100) en todos sus ambitos', NEW.organizer_id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT reservation_settings INTO v_settings
    FROM public.restaurants
    WHERE id = NEW.restaurant_id;

    IF v_settings IS NULL THEN
        RETURN NEW;
    END IF;

    v_max_pax := (v_settings->>'max_party_size')::integer;
    v_min_reputation := (v_settings->>'min_reputation')::integer;

    -- Sin parametros del restaurante no se aprueba automaticamente (queda PENDIENTE).
    IF v_max_pax IS NULL OR v_min_reputation IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.user_id IS NOT NULL THEN
        SELECT COALESCE(reservation_reputation, 100) INTO v_user_reputation
        FROM public.profiles
        WHERE id = NEW.user_id;
    ELSE
        v_user_reputation := 0;
    END IF;

    IF NEW.status = 'PENDIENTE' AND
       NEW.party_size <= v_max_pax AND
       v_user_reputation >= v_min_reputation THEN

        NEW.status := 'CONFIRMADA';
    END IF;

    RETURN NEW;
END;
$function$;$m022a$;
    EXECUTE $m022b$CREATE OR REPLACE FUNCTION public.auto_approve_takeaway_order()
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

    IF (NEW.status IN ('PENDIENTE', 'CREADA')) AND NEW.total_amount <= v_max_amount AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;$m022b$;

    UPDATE profiles SET takeaway_reputation = 100, reservation_reputation = 100 WHERE id = uB;

    -- PEDIDOS
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000, 'min_reputation', 80) WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, '[]'::jsonb, 10000, 'P1') RETURNING * INTO o;
    rep := rep || format(E'p1) ambos criterios ok -> %s (esperado APROBADA)\n', o.status);
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, '[]'::jsonb, 200000, 'P2') RETURNING * INTO o;
    rep := rep || format(E'p2) monto sobre el maximo -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE profiles SET takeaway_reputation = 50 WHERE id = uB;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, '[]'::jsonb, 10000, 'P3') RETURNING * INTO o;
    rep := rep || format(E'p3) reputacion bajo el minimo -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE profiles SET takeaway_reputation = 100 WHERE id = uB;
    UPDATE restaurants SET takeaway_settings = '{}'::jsonb WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, '[]'::jsonb, 10000, 'P4') RETURNING * INTO o;
    rep := rep || format(E'p4) restaurante SIN parametros -> %s (esperado PENDIENTE, sin default de plataforma)\n', o.status);
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000) WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, '[]'::jsonb, 10000, 'P5') RETURNING * INTO o;
    rep := rep || format(E'p5) falta min_reputation -> %s (esperado PENDIENTE)\n', o.status);

    -- RESERVAS (trigger: usa NEW.user_id; se prueba con user_id informado)
    UPDATE restaurants SET reservation_settings = jsonb_build_object('max_party_size', 10, 'min_reputation', 80) WHERE id = rid;
    INSERT INTO reservations(restaurant_id, organizer_id, user_id, date_time, party_size, status) VALUES (rid, uB, uB, now() + interval '3 days', 4, 'PENDIENTE') RETURNING * INTO r;
    rep := rep || format(E'r1) ambos criterios ok (user_id informado) -> %s (esperado CONFIRMADA)\n', r.status);
    INSERT INTO reservations(restaurant_id, organizer_id, user_id, date_time, party_size, status) VALUES (rid, uB, uB, now() + interval '4 days', 11, 'PENDIENTE') RETURNING * INTO r;
    rep := rep || format(E'r2) grupo sobre el maximo -> %s (esperado PENDIENTE)\n', r.status);
    UPDATE restaurants SET reservation_settings = '{}'::jsonb WHERE id = rid;
    INSERT INTO reservations(restaurant_id, organizer_id, user_id, date_time, party_size, status) VALUES (rid, uB, uB, now() + interval '5 days', 2, 'PENDIENTE') RETURNING * INTO r;
    rep := rep || format(E'r3) restaurante SIN parametros -> %s (esperado PENDIENTE)\n', r.status);

    RAISE EXCEPTION E'TEST_REPORT (transaccion revertida)\n%', rep;
END
$test$;
