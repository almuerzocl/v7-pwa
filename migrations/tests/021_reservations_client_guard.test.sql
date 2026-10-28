-- Prueba de 021_reservations_client_guard.sql contra datos REALES de produccion (kqanordhsmbtcwtjtrme).
-- Un unico DO que termina en RAISE EXCEPTION: revierte todo (filas, funcion y trigger). El resultado llega
-- como texto del error 'TEST_REPORT'. Simula el rol con request.jwt.claims (lo que lee inventory_caller_role()).
-- Bloque $m021$ = copia literal de la migracion. Requiere 021 NO aplicada aun.
DO $test$
DECLARE
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    rep text := '';
    r record;
    ok boolean;
BEGIN
    EXECUTE $m021$CREATE OR REPLACE FUNCTION public.reservations_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    -- is_super_admin() no tiene EXECUTE para anon: solo se consulta con rol authenticated.
    IF public.inventory_caller_role() = 'anon'
       OR (public.inventory_caller_role() = 'authenticated' AND NOT public.is_super_admin()) THEN
        IF NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
        OR NEW.organizer_id  IS DISTINCT FROM OLD.organizer_id
        OR NEW.user_id       IS DISTINCT FROM OLD.user_id
        OR NEW.date_time     IS DISTINCT FROM OLD.date_time
        OR NEW.party_size    IS DISTINCT FROM OLD.party_size THEN
            RAISE EXCEPTION 'El cliente no puede modificar restaurante, organizador, fecha ni tamano de la reserva'
                USING ERRCODE = 'RSV01';
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
               OLD.status = 'CONFIRMADA' AND NEW.status = 'CHECK-IN CLIENTE'
        ) THEN
            RAISE EXCEPTION 'Transicion no permitida para el cliente: % -> %', OLD.status, NEW.status
                USING ERRCODE = 'RSV02';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.reservations_client_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reservations_client_guard() TO service_role;

DROP TRIGGER IF EXISTS tr_reservations_client_guard ON public.reservations;
CREATE TRIGGER tr_reservations_client_guard
    BEFORE UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.reservations_client_guard();
$m021$;

    INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size, status)
    VALUES (rid, uB, now() + interval '3 days', 2, 'PENDIENTE') RETURNING * INTO r;
    UPDATE reservations SET status = 'CONFIRMADA' WHERE id = r.id;   -- sin claims (postgres): permitido

    PERFORM set_config('request.jwt.claims', json_build_object('role','authenticated','sub',uB)::text, true);

    -- a) check-in legitimo CONFIRMADA -> CHECK-IN CLIENTE: permitido
    BEGIN UPDATE reservations SET status = 'CHECK-IN CLIENTE', timestamps = '{"checkin_at":"x"}'::jsonb WHERE id = r.id;
          rep := rep || E'a) cliente check-in CONFIRMADA->CHECK-IN CLIENTE -> permitido (OK)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'a) check-in -> rechazado %s (FALLA)\n', SQLSTATE); END;

    -- b) guests (sin cambio de status): permitido
    BEGIN UPDATE reservations SET guests = '[]'::jsonb WHERE id = r.id;
          rep := rep || E'b) cliente actualiza guests -> permitido (OK)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'b) guests -> rechazado %s (FALLA)\n', SQLSTATE); END;

    -- c) cancelar directo: bloqueado
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE reservations SET status = 'CONFIRMADA' WHERE id = r.id;   -- vuelve el estado como postgres
    PERFORM set_config('request.jwt.claims', json_build_object('role','authenticated','sub',uB)::text, true);
    BEGIN UPDATE reservations SET status = 'CANCELADA' WHERE id = r.id;
          rep := rep || E'c) cliente CONFIRMADA->CANCELADA directo -> PERMITIDO (FALLA)\n';
    EXCEPTION WHEN SQLSTATE 'RSV02' THEN rep := rep || E'c) cliente CONFIRMADA->CANCELADA directo -> bloqueado RSV02 (OK)\n';
              WHEN OTHERS THEN rep := rep || format(E'c) error inesperado %s\n', SQLSTATE); END;

    -- d) otros estados: bloqueados
    BEGIN UPDATE reservations SET status = 'COMPLETADA' WHERE id = r.id;
          rep := rep || E'd) cliente ->COMPLETADA -> PERMITIDO (FALLA)\n';
    EXCEPTION WHEN SQLSTATE 'RSV02' THEN rep := rep || E'd) cliente ->COMPLETADA -> bloqueado RSV02 (OK)\n'; END;
    BEGIN UPDATE reservations SET status = 'NO_SHOW' WHERE id = r.id;
          rep := rep || E'd2) cliente ->NO_SHOW -> PERMITIDO (FALLA)\n';
    EXCEPTION WHEN SQLSTATE 'RSV02' THEN rep := rep || E'd2) cliente ->NO_SHOW -> bloqueado RSV02 (OK)\n'; END;

    -- e) mover date_time / party_size / restaurante: bloqueado
    BEGIN UPDATE reservations SET date_time = now() + interval '30 days' WHERE id = r.id;
          rep := rep || E'e) cliente mueve date_time -> PERMITIDO (FALLA)\n';
    EXCEPTION WHEN SQLSTATE 'RSV01' THEN rep := rep || E'e) cliente mueve date_time -> bloqueado RSV01 (OK)\n'; END;
    BEGIN UPDATE reservations SET party_size = 1 WHERE id = r.id;
          rep := rep || E'e2) cliente cambia party_size -> PERMITIDO (FALLA)\n';
    EXCEPTION WHEN SQLSTATE 'RSV01' THEN rep := rep || E'e2) cliente cambia party_size -> bloqueado RSV01 (OK)\n'; END;

    -- f) service_role: sin restriccion
    PERFORM set_config('request.jwt.claims', json_build_object('role','service_role')::text, true);
    BEGIN UPDATE reservations SET status = 'CANCELADA', date_time = date_time + interval '1 day' WHERE id = r.id;
          rep := rep || E'f) service_role cambia estado y fecha -> permitido (OK)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'f) service_role -> rechazado %s (FALLA)\n', SQLSTATE); END;

    -- g) permisos de la funcion de trigger
    rep := rep || format(E'g) EXECUTE anon=%s authenticated=%s service_role=%s (esperado f f t)\n',
        has_function_privilege('anon','public.reservations_client_guard()','EXECUTE'),
        has_function_privilege('authenticated','public.reservations_client_guard()','EXECUTE'),
        has_function_privilege('service_role','public.reservations_client_guard()','EXECUTE'));

    RAISE EXCEPTION E'TEST_REPORT (transaccion revertida)\n%', rep;
END
$test$;
