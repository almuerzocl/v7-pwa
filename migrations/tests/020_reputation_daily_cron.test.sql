-- Prueba de 020_reputation_daily_cron.sql contra datos REALES de produccion (kqanordhsmbtcwtjtrme).
-- No deja nada: un unico DO que termina en RAISE EXCEPTION (revierte filas, cambios en profiles y la
-- funcion). El resultado llega como texto del error 'TEST_REPORT'. Solo prueba la funcion (el job es de Cloud
-- Scheduler: pwa-calculate-reputation). Bloque $m020$ = copia literal de la funcion.
-- Estrategia: se mide la linea base del usuario de prueba en la ventana y se le suman operaciones
-- conocidas; el esperado se calcula como ROUND(100*(ok+a)/(ok+a+bad+b)).
DO $test$
DECLARE
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    rep text := '';
    hasta timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago';
    r_ok int; r_bad int; o_ok int; o_bad int;
    rr int; tr int; esp_r int; esp_t int; antes int; despues int;
    t0 timestamptz;
BEGIN
    EXECUTE $m020$CREATE OR REPLACE FUNCTION public.calculate_daily_reputation()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_hasta timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago';
    v_desde timestamptz := (date_trunc('day', now() AT TIME ZONE 'America/Santiago') - interval '30 days') AT TIME ZONE 'America/Santiago';
BEGIN
    WITH res AS (
        SELECT organizer_id AS id,
               count(*) FILTER (WHERE status IN ('COMPLETADA', 'CHECK-IN CLIENTE')) AS ok,
               count(*) FILTER (WHERE status = 'NO_SHOW') AS bad
        FROM public.reservations
        WHERE organizer_id IS NOT NULL
          AND date_time >= v_desde AND date_time < v_hasta
        GROUP BY organizer_id
    ),
    ord AS (
        SELECT user_id AS id,
               count(*) FILTER (WHERE status IN ('ENTREGADO', 'COMPLETADO')) AS ok,
               count(*) FILTER (WHERE status = 'NO_RETIRADO') AS bad
        FROM public.takeaway_orders
        WHERE user_id IS NOT NULL
          AND created_at >= v_desde AND created_at < v_hasta
        GROUP BY user_id
    ),
    nuevo AS (
        SELECT p.id,
               COALESCE(ROUND(100.0 * res.ok / NULLIF(res.ok + res.bad, 0)), 100)::int AS reservation_reputation,
               COALESCE(ROUND(100.0 * ord.ok / NULLIF(ord.ok + ord.bad, 0)), 100)::int AS takeaway_reputation
        FROM public.profiles p
        LEFT JOIN res ON res.id = p.id
        LEFT JOIN ord ON ord.id = p.id
    )
    UPDATE public.profiles p
       SET reservation_reputation = nuevo.reservation_reputation,
           takeaway_reputation    = nuevo.takeaway_reputation
      FROM nuevo
     WHERE nuevo.id = p.id
       AND (p.reservation_reputation IS DISTINCT FROM nuevo.reservation_reputation
         OR p.takeaway_reputation    IS DISTINCT FROM nuevo.takeaway_reputation);
END;
$function$;$m020$;

    SELECT count(*) FILTER (WHERE status IN ('COMPLETADA','CHECK-IN CLIENTE')), count(*) FILTER (WHERE status='NO_SHOW')
      INTO r_ok, r_bad FROM reservations WHERE organizer_id = uB AND date_time >= hasta - interval '30 days' AND date_time < hasta;
    SELECT count(*) FILTER (WHERE status IN ('ENTREGADO','COMPLETADO')), count(*) FILTER (WHERE status='NO_RETIRADO')
      INTO o_ok, o_bad FROM takeaway_orders WHERE user_id = uB AND created_at >= hasta - interval '30 days' AND created_at < hasta;
    rep := rep || format(E'base) usuario B en ventana: reservas ok=%s bad=%s, pedidos ok=%s bad=%s\n', r_ok, r_bad, o_ok, o_bad);

    -- Reservas: +2 COMPLETADA, +1 CHECK-IN CLIENTE, +1 NO_SHOW dentro de la ventana; ruido que NO debe contar:
    -- CANCELADA, RECHAZADA, CONFIRMADA dentro de la ventana; NO_SHOW de hace 31 dias; NO_SHOW de HOY.
    INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size, status) VALUES
      (rid, uB, hasta - interval '3 days', 2, 'PENDIENTE'), (rid, uB, hasta - interval '4 days', 2, 'PENDIENTE'),
      (rid, uB, hasta - interval '5 days', 2, 'PENDIENTE'), (rid, uB, hasta - interval '6 days', 2, 'PENDIENTE'),
      (rid, uB, hasta - interval '7 days', 2, 'PENDIENTE'), (rid, uB, hasta - interval '8 days', 2, 'PENDIENTE'),
      (rid, uB, hasta - interval '9 days', 2, 'PENDIENTE'), (rid, uB, hasta - interval '40 days', 2, 'PENDIENTE'),
      (rid, uB, hasta + interval '2 hours', 2, 'PENDIENTE');
    t0 := clock_timestamp();
    UPDATE reservations SET status = x.s FROM (VALUES
      (hasta - interval '3 days', 'COMPLETADA'), (hasta - interval '4 days', 'COMPLETADA'),
      (hasta - interval '5 days', 'CHECK-IN CLIENTE'), (hasta - interval '6 days', 'NO_SHOW'),
      (hasta - interval '7 days', 'CANCELADA'), (hasta - interval '8 days', 'RECHAZADA'),
      (hasta - interval '9 days', 'CONFIRMADA'), (hasta - interval '40 days', 'NO_SHOW'),
      (hasta + interval '2 hours', 'NO_SHOW')) AS x(d, s)
      WHERE organizer_id = uB AND date_time = x.d AND restaurant_id = rid;
    r_ok := r_ok + 3; r_bad := r_bad + 1;

    -- Pedidos: estados distintos con created_at forzado en la ventana (items vacios + total 0).
    INSERT INTO takeaway_orders(user_id, restaurant_id, items, total_amount, customer_name, created_at) VALUES
      (uB, rid, '[]'::jsonb, 0, 'T1', hasta - interval '3 days'), (uB, rid, '[]'::jsonb, 0, 'T2', hasta - interval '4 days'),
      (uB, rid, '[]'::jsonb, 0, 'T3', hasta - interval '5 days'), (uB, rid, '[]'::jsonb, 0, 'T4', hasta - interval '6 days'),
      (uB, rid, '[]'::jsonb, 0, 'T5', hasta - interval '40 days');
    UPDATE takeaway_orders SET status = x.s FROM (VALUES
      ('T1','ENTREGADO'), ('T2','COMPLETADO'), ('T3','NO_RETIRADO'), ('T4','CANCELADO'), ('T5','NO_RETIRADO')) AS x(n, s)
      WHERE user_id = uB AND customer_name = x.n;
    o_ok := o_ok + 2; o_bad := o_bad + 1;

    esp_r := COALESCE(ROUND(100.0 * r_ok / NULLIF(r_ok + r_bad, 0)), 100)::int;
    esp_t := COALESCE(ROUND(100.0 * o_ok / NULLIF(o_ok + o_bad, 0)), 100)::int;

    PERFORM calculate_daily_reputation();
    SELECT reservation_reputation, takeaway_reputation INTO rr, tr FROM profiles WHERE id = uB;
    rep := rep || format(E'1) reservas: %s/%s -> %s (esperado %s) %s\n', r_ok, r_ok + r_bad, rr, esp_r, CASE WHEN rr = esp_r THEN 'OK' ELSE 'FALLA' END);
    rep := rep || format(E'2) pedidos : %s/%s -> %s (esperado %s) %s\n', o_ok, o_ok + o_bad, tr, esp_t, CASE WHEN tr = esp_t THEN 'OK' ELSE 'FALLA' END);

    -- Idempotencia: segunda corrida no cambia nada.
    SELECT sum(reservation_reputation + takeaway_reputation) INTO antes FROM profiles;
    PERFORM calculate_daily_reputation();
    SELECT sum(reservation_reputation + takeaway_reputation) INTO despues FROM profiles;
    rep := rep || format(E'3) idempotente: suma antes=%s despues=%s %s\n', antes, despues, CASE WHEN antes = despues THEN 'OK' ELSE 'FALLA' END);

    -- Rango y NOT NULL en todos los perfiles.
    rep := rep || format(E'4) perfiles fuera de 0..100 o NULL: %s (esperado 0)\n',
        (SELECT count(*) FROM profiles WHERE reservation_reputation NOT BETWEEN 0 AND 100 OR takeaway_reputation NOT BETWEEN 0 AND 100
            OR reservation_reputation IS NULL OR takeaway_reputation IS NULL));

    -- Permisos: EXECUTE solo service_role.
    rep := rep || format(E'5) EXECUTE anon=%s authenticated=%s service_role=%s (esperado f f t)\n',
        has_function_privilege('anon', 'public.calculate_daily_reputation()', 'EXECUTE'),
        has_function_privilege('authenticated', 'public.calculate_daily_reputation()', 'EXECUTE'),
        has_function_privilege('service_role', 'public.calculate_daily_reputation()', 'EXECUTE'));

    RAISE EXCEPTION E'TEST_REPORT (transaccion revertida)\n%', rep;
END
$test$;
