-- Prueba de 028_security_private_tables_and_is_super_admin.sql contra datos REALES de produccion (kqanordhsmbtcwtjtrme).
-- Una sola transaccion que termina en ROLLBACK (revierte migracion y pruebas). Pegar completa en el SQL Editor / execute_sql.
-- Simula roles con SET LOCAL ROLE + request.jwt.claims. Requiere 028 NO aplicada aun (si ya esta aplicada, omitir el bloque de migracion).
-- Salida: tabla (test, outcome). Esperado "despues": ver comentarios `-- espera:`.
BEGIN;
CREATE TEMP TABLE res(test text, outcome text);
GRANT ALL ON res TO PUBLIC;

-- ===== inicio copia literal de la migracion (sin BEGIN/COMMIT) =====
-- 1) Politicas explicitas para service_role. service_role bypassea RLS, asi que no cambia el acceso real:
--    deja la intencion escrita y evita el aviso "RLS enabled, no policy". anon/authenticated siguen sin
--    policy NI grant (doble cierre).
DROP POLICY IF EXISTS error_logs_service_role_all ON public.error_logs;
CREATE POLICY error_logs_service_role_all ON public.error_logs
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS restaurant_payments_service_role_all ON public.restaurant_payments;
CREATE POLICY restaurant_payments_service_role_all ON public.restaurant_payments
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Ledger inmutable: solo lectura (las escrituras las hacen funciones del owner, que no pasan por esta policy).
DROP POLICY IF EXISTS inventory_movements_service_role_select ON public.inventory_movements;
CREATE POLICY inventory_movements_service_role_select ON public.inventory_movements
    AS PERMISSIVE FOR SELECT TO service_role USING (true);

-- 2) is_super_admin() a esquema privado. ALTER ... SET SCHEMA conserva el OID: la policy de profiles y los
--    permisos siguen apuntando a la misma funcion. El esquema `private` no esta en los esquemas expuestos de
--    PostgREST, asi que deja de existir como /rpc/is_super_admin.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;   -- necesario para evaluar la policy y el guard

ALTER FUNCTION public.is_super_admin() SET SCHEMA private;
REVOKE EXECUTE ON FUNCTION private.is_super_admin() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION private.is_super_admin() TO authenticated, service_role;

-- La unica funcion que la llamaba por nombre (el cuerpo plpgsql no sigue el cambio de esquema).
CREATE OR REPLACE FUNCTION public.reservations_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    -- private.is_super_admin() no tiene EXECUTE para anon: solo se consulta con rol authenticated.
    IF public.inventory_caller_role() = 'anon'
       OR (public.inventory_caller_role() = 'authenticated' AND NOT private.is_super_admin()) THEN
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

-- ===== fin copia literal =====

DO $test$
DECLARE
  sup uuid := '04b657f3-3aac-47f5-a7ad-51495f09731e';
  stf uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
  usr uuid := '18d25d98-92c4-4368-b5e3-8e2560fa008e';
  rA uuid := '884331c1-6fb7-4b05-ac8f-4e6fce81872a';
  rB uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
  v text; r text; t text; actor record; resv record;
BEGIN
  FOR actor IN SELECT * FROM (VALUES ('anon',NULL::uuid),('authenticated',usr),('authenticated_staff',stf),('authenticated_super',sup),('service_role',NULL::uuid)) a(role_name, uid) LOOP
    r := CASE WHEN actor.role_name LIKE 'authenticated%' THEN 'authenticated' ELSE actor.role_name END;
    FOR t IN SELECT unnest(array['error_logs','inventory_movements','restaurant_payments']) LOOP
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('role', r, 'sub', actor.uid)::text, true);
        EXECUTE format('set local role %I', r);
        EXECUTE format('select count(*) from public.%I', t) INTO v;
        EXECUTE 'reset role';
        INSERT INTO res VALUES (actor.role_name||' SELECT '||t, 'ok count='||v);       -- espera: solo service_role ok
      EXCEPTION WHEN others THEN EXECUTE 'reset role'; INSERT INTO res VALUES (actor.role_name||' SELECT '||t, 'DENIED '||sqlstate); END;
    END LOOP;
    -- escritura de service_role en las 2 tablas con INSERT/UPDATE (no se inserta nada: WHERE false)
    IF r = 'service_role' THEN
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('role', r)::text, true);
        EXECUTE 'set local role service_role';
        EXECUTE 'update public.error_logs set id = id where false'; EXECUTE 'update public.restaurant_payments set id = id where false';
        EXECUTE 'reset role';
        INSERT INTO res VALUES ('service_role UPDATE error_logs/restaurant_payments','ok');
      EXCEPTION WHEN others THEN EXECUTE 'reset role'; INSERT INTO res VALUES ('service_role UPDATE error_logs/restaurant_payments','DENIED '||sqlstate); END;
    END IF;
    -- funcion vieja (espera: DENIED 42883 funcion inexistente para todos)
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('role', r, 'sub', actor.uid)::text, true);
      EXECUTE format('set local role %I', r);
      EXECUTE 'select public.is_super_admin()::text' INTO v;
      EXECUTE 'reset role';
      INSERT INTO res VALUES (actor.role_name||' public.is_super_admin()', 'ok '||v);
    EXCEPTION WHEN others THEN EXECUTE 'reset role'; INSERT INTO res VALUES (actor.role_name||' public.is_super_admin()', 'DENIED '||sqlstate); END;
    -- funcion nueva (espera: anon DENIED 42501; authenticated ok false; super ok true)
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('role', r, 'sub', actor.uid)::text, true);
      EXECUTE format('set local role %I', r);
      EXECUTE 'select private.is_super_admin()::text' INTO v;
      EXECUTE 'reset role';
      INSERT INTO res VALUES (actor.role_name||' private.is_super_admin()', 'ok '||v);
    EXCEPTION WHEN others THEN EXECUTE 'reset role'; INSERT INTO res VALUES (actor.role_name||' private.is_super_admin()', 'DENIED '||sqlstate); END;
    -- policy de profiles (espera: user 1, staff 1, super 35)
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('role', r, 'sub', actor.uid)::text, true);
      EXECUTE format('set local role %I', r);
      EXECUTE 'select count(*)::text from public.profiles' INTO v;
      EXECUTE 'reset role';
      INSERT INTO res VALUES (actor.role_name||' profiles visibles', v);
    EXCEPTION WHEN others THEN EXECUTE 'reset role'; INSERT INTO res VALUES (actor.role_name||' profiles visibles', 'DENIED '||sqlstate); END;
  END LOOP;

  -- guard de reservations (usa private.is_super_admin): un cliente no-super no puede cambiar party_size (espera: RSV01)
  SELECT id, organizer_id INTO resv FROM public.reservations WHERE organizer_id IS NOT NULL AND organizer_id <> sup LIMIT 1;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role','authenticated','sub',resv.organizer_id)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.reservations SET party_size = party_size + 1 WHERE id = resv.id;
    RESET ROLE;
    INSERT INTO res VALUES ('guard reservations (cliente cambia party_size)', 'NO bloqueo (malo)');
  EXCEPTION WHEN others THEN RESET ROLE; INSERT INTO res VALUES ('guard reservations (cliente cambia party_size)', 'bloqueado '||sqlstate); END;

  -- metricas del restaurante: la guardia sigue igual tras mover is_super_admin (espera: staffA ok/B denied; super ok; service_role ok)
  FOREACH t IN ARRAY array['A','B'] LOOP
    FOR actor IN SELECT * FROM (VALUES ('authenticated_staff',stf),('authenticated_super',sup)) a(role_name, uid) LOOP
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('role','authenticated','sub',actor.uid)::text, true);
        SET LOCAL ROLE authenticated;
        PERFORM public.get_restaurant_dashboard_metrics(CASE t WHEN 'A' THEN rA ELSE rB END);
        RESET ROLE;
        INSERT INTO res VALUES (actor.role_name||' metrics rest'||t, 'ok');
      EXCEPTION WHEN others THEN RESET ROLE; INSERT INTO res VALUES (actor.role_name||' metrics rest'||t, 'DENIED '||sqlstate); END;
    END LOOP;
  END LOOP;

  -- esquemas expuestos por PostgREST (espera: sin 'private')
  SELECT coalesce(string_agg(c, ' | '), 'sin config') INTO v FROM pg_roles ro, unnest(ro.rolconfig) c WHERE ro.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas%';
  INSERT INTO res VALUES ('authenticator pgrst.db_schemas', v);
  -- cuerpos de funcion que aun nombran public.is_super_admin (espera: 0)
  SELECT count(*)::text INTO v FROM pg_proc WHERE prosrc ILIKE '%public.is_super_admin%' AND pronamespace <> 'pg_catalog'::regnamespace;
  INSERT INTO res VALUES ('funciones con public.is_super_admin', v);
END
$test$;
SELECT * FROM res ORDER BY 1;
ROLLBACK;
