-- 028: (1) politicas explicitas service_role en las 3 tablas privadas; (2) is_super_admin() a un esquema
--      privado no expuesto por la Data API.
--
-- Estado real verificado en produccion (2026-10-04, kqanordhsmbtcwtjtrme):
--   * error_logs, inventory_movements, restaurant_payments: RLS activa, 0 policies, GRANT solo a service_role
--     (inventory_movements solo SELECT: el ledger se escribe desde funciones SECURITY DEFINER).
--     Lecturas en codigo: error_logs solo con supabaseAdmin() (pwa); inventory_movements solo desde
--     funciones SQL; restaurant_payments desde restaurant-dashboard (ver cambio de codigo aparte: leia con
--     la sesion del usuario y por eso fallaba con 42501).
--   * public.is_super_admin(): SECURITY DEFINER, sin EXECUTE para anon, usada por 1 policy
--     (profiles_select_super_admin) y por public.reservations_client_guard(). Ningun cliente la llama por RPC.
--
-- Sin ORDEN DE DESPLIEGUE con codigo: ningun componente referencia is_super_admin ni estas policies.
-- Sin tablas nuevas -> sin GRANT de tabla nuevos (los GRANT ya existen y no se tocan).
-- Rollback: ver bloque al final (comentado).

BEGIN;

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

COMMIT;

-- Verificacion posterior:
--   select to_regprocedure('public.is_super_admin()');                  -- NULL
--   select to_regprocedure('private.is_super_admin()');                 -- existe
--   select proacl from pg_proc where oid = 'private.is_super_admin()'::regprocedure;  -- sin anon
--   select count(*) from pg_proc where prosrc ilike '%public.is_super_admin%';        -- 0
--   ver pwa/migrations/tests/028_private_tables_and_is_super_admin.test.sql

-- Rollback:
--   ALTER FUNCTION private.is_super_admin() SET SCHEMA public;
--   (re-ejecutar el CREATE OR REPLACE de public.reservations_client_guard() de 021)
--   DROP POLICY error_logs_service_role_all ON public.error_logs;
--   DROP POLICY restaurant_payments_service_role_all ON public.restaurant_payments;
--   DROP POLICY inventory_movements_service_role_select ON public.inventory_movements;
--   (el esquema private puede quedar vacio)
