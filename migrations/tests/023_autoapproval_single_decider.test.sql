-- OBSOLETA EN PARTE (2026-10-06): la migracion 037 retiro el criterio de unidades (max_items) de auto_approve_takeaway_order.
-- Los casos p2 (16 unidades -> PENDIENTE), p3 y p6 (falta max_items -> PENDIENTE) de este archivo ya no describen la
-- base real. Los reemplaza 037_autoapproval_orders_amount_reputation_only.test.sql. Se conserva como registro historico
-- de la 023 (reservas incluidas); no se vuelve a ejecutar tal cual.
-- Prueba de 023_autoapproval_single_decider.sql contra datos REALES de produccion (kqanordhsmbtcwtjtrme).
-- Un unico DO que termina en RAISE EXCEPTION: revierte todo (filas, cambios en profiles/restaurants y las
-- funciones). El resultado llega como texto del error 'TEST_REPORT'. Requiere 022 aplicada. Bloques
-- $m023a$ / $m023b$ = copias literales de la migracion.
DO $test$
DECLARE
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    rep text := '';
    o record;
    r record;
    it jsonb;
    n_notif int;
BEGIN
    EXECUTE $m023a$CREATE OR REPLACE FUNCTION public.auto_approve_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_settings jsonb;
    v_max_pax integer;
    v_min_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
    v_restaurant_name text;
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

    -- Ambos criterios son concurrentes.
    IF NEW.status = 'PENDIENTE' AND
       NEW.party_size <= v_max_pax AND
       v_reservation_reputation >= v_min_reputation THEN

        NEW.status := 'CONFIRMADA';
        NEW.approved_at := now();
        NEW.confirmed_at := now();
        NEW.timestamps := COALESCE(NEW.timestamps, '{}'::jsonb) || jsonb_build_object(
            'CONFIRMADA', jsonb_build_object(
                'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'actor_id', NEW.organizer_id::text,
                'actor_role', 'system',
                'reason', format('Auto-aprobada: reputacion %s >= %s, grupo %s <= %s',
                                 v_reservation_reputation, v_min_reputation, NEW.party_size, v_max_pax)
            )
        );

        -- Notificacion in-app al cliente (mismo contenido que transition_status para CONFIRMADA).
        BEGIN
            SELECT name INTO v_restaurant_name FROM public.restaurants WHERE id = NEW.restaurant_id;
            INSERT INTO public.notifications (user_id, restaurant_id, type, title, message, related_id, priority, actor_id, actor_role)
            VALUES (NEW.organizer_id, NEW.restaurant_id, 'RESERVATION', COALESCE(v_restaurant_name, 'Restaurante'),
                    'Tu reserva ha sido confirmada', NEW.id, 'NORMAL', NEW.organizer_id, 'system');
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'auto_approve_reservation: no se pudo crear la notificacion (%): %', SQLSTATE, SQLERRM;
        END;
    END IF;

    RETURN NEW;
END;
$function$;$m023a$;
    EXECUTE $m023b$CREATE OR REPLACE FUNCTION public.auto_approve_takeaway_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_settings jsonb;
    v_max_amount numeric;
    v_max_items integer;
    v_min_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
    v_items jsonb;
    v_units integer := 0;
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
    v_max_items := (v_settings->>'max_items')::integer;
    v_min_reputation := (v_settings->>'min_reputation')::integer;

    -- Sin parametros del restaurante no se aprueba automaticamente (queda PENDIENTE).
    IF v_max_amount IS NULL OR v_max_items IS NULL OR v_min_reputation IS NULL THEN RETURN NEW; END IF;

    -- Unidades del pedido: suma de quantity (items puede venir como array o como string JSON).
    v_items := NEW.items;
    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'string' THEN
        v_items := (v_items #>> '{}')::jsonb;
    END IF;
    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'array' THEN
        SELECT COALESCE(SUM(trunc(COALESCE(NULLIF(t.e->>'quantity', '')::numeric, 1))), 0)::integer
          INTO v_units
          FROM jsonb_array_elements(v_items) AS t(e);
    END IF;

    -- Los tres criterios son concurrentes.
    IF (NEW.status IN ('PENDIENTE', 'CREADA'))
       AND NEW.total_amount <= v_max_amount
       AND v_units <= v_max_items
       AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;$m023b$;

    UPDATE profiles SET takeaway_reputation = 100, reservation_reputation = 100 WHERE id = uB;

    -- RESERVAS: la reputacion que cuenta es la del ORGANIZADOR (user_id NULL, como crea la PWA)
    UPDATE restaurants SET reservation_settings = jsonb_build_object('max_party_size', 10, 'min_reputation', 80) WHERE id = rid;
    INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size, status, timestamps)
    VALUES (rid, uB, now() + interval '3 days', 4, 'PENDIENTE', '{"SOLICITADO":{"at":"x"}}'::jsonb) RETURNING * INTO r;
    rep := rep || format(E'r1) ambos criterios ok, user_id NULL -> %s (esperado CONFIRMADA) approved_at=%s confirmed_at=%s rastro=%s conserva_previo=%s\n',
        r.status, r.approved_at IS NOT NULL, r.confirmed_at IS NOT NULL,
        r.timestamps->'CONFIRMADA'->>'actor_role', r.timestamps ? 'SOLICITADO');
    SELECT count(*) INTO n_notif FROM notifications WHERE related_id = r.id AND user_id = uB AND type = 'RESERVATION' AND message = 'Tu reserva ha sido confirmada' AND priority = 'NORMAL' AND actor_role = 'system';
    rep := rep || format(E'r1b) notificacion al cliente de la reserva autoaprobada -> %s fila(s) (esperado 1)\n', n_notif);
    INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size, status) VALUES (rid, uB, now() + interval '4 days', 11, 'PENDIENTE') RETURNING * INTO r;
    rep := rep || format(E'r2) grupo sobre el maximo -> %s (esperado PENDIENTE)\n', r.status);
    SELECT count(*) INTO n_notif FROM notifications WHERE related_id = r.id;
    rep := rep || format(E'r2b) reserva que NO se autoaprueba -> %s notificaciones (esperado 0)\n', n_notif);
    UPDATE profiles SET reservation_reputation = 50 WHERE id = uB;
    INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size, status) VALUES (rid, uB, now() + interval '5 days', 2, 'PENDIENTE') RETURNING * INTO r;
    rep := rep || format(E'r3) reputacion de reservas bajo el minimo (take=100) -> %s (esperado PENDIENTE)\n', r.status);
    UPDATE profiles SET reservation_reputation = 100 WHERE id = uB;
    UPDATE restaurants SET reservation_settings = '{}'::jsonb WHERE id = rid;
    INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size, status) VALUES (rid, uB, now() + interval '6 days', 2, 'PENDIENTE') RETURNING * INTO r;
    rep := rep || format(E'r4) restaurante SIN parametros -> %s (esperado PENDIENTE)\n', r.status);

    -- PEDIDOS: tres criterios concurrentes
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000, 'max_items', 15, 'min_reputation', 80) WHERE id = rid;
    it := jsonb_build_array(jsonb_build_object('id','x1','quantity',2), jsonb_build_object('id','x2','quantity',3));
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, it, 10000, 'P1') RETURNING * INTO o;
    rep := rep || format(E'p1) 5 unidades, monto y reputacion ok -> %s (esperado APROBADA)\n', o.status);
    it := jsonb_build_array(jsonb_build_object('id','x1','quantity',16));
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, it, 10000, 'P2') RETURNING * INTO o;
    rep := rep || format(E'p2) 16 unidades (max 15) -> %s (esperado PENDIENTE)\n', o.status);
    it := jsonb_build_array(jsonb_build_object('id','x1','quantity',15));
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, it, 10000, 'P3') RETURNING * INTO o;
    rep := rep || format(E'p3) 15 unidades (justo el maximo) -> %s (esperado APROBADA)\n', o.status);
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1','quantity',1)), 200000, 'P4') RETURNING * INTO o;
    rep := rep || format(E'p4) monto sobre el maximo -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE profiles SET takeaway_reputation = 50 WHERE id = uB;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1','quantity',1)), 10000, 'P5') RETURNING * INTO o;
    rep := rep || format(E'p5) reputacion bajo el minimo -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE profiles SET takeaway_reputation = 100 WHERE id = uB;
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000, 'min_reputation', 80) WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1','quantity',1)), 10000, 'P6') RETURNING * INTO o;
    rep := rep || format(E'p6) falta max_items -> %s (esperado PENDIENTE)\n', o.status);
    UPDATE restaurants SET takeaway_settings = jsonb_build_object('max_order_amount', 150000, 'max_items', 15, 'min_reputation', 80) WHERE id = rid;
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name) VALUES (uB, rid, jsonb_build_array(jsonb_build_object('id','x1')), 10000, 'P7') RETURNING * INTO o;
    rep := rep || format(E'p7) item sin quantity (cuenta 1) -> %s (esperado APROBADA)\n', o.status);

    RAISE EXCEPTION E'TEST_REPORT (transaccion revertida)\n%', rep;
END
$test$;
