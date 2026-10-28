-- 030: reservations y takeaway_orders -- cerrar la lectura por codigo a cualquier usuario con sesion.
--
-- REDACTADA, NO APLICADA. Orden de despliegue: primero el codigo de servidor (PR de
-- feature/rls-reservas-pedidos: my-tickets-actions), despues esta migracion. Si se aplica antes, las
-- pantallas /reservations, /reservations/[id] y /orders/[id] dejan de ver lo que hoy leen por codigo.
--
-- Verificado en produccion (2026-10-04, pg_policies / role_table_grants):
--   * "Authenticated access by unique_code" (SELECT, authenticated, unique_code IS NOT NULL) en ambas tablas:
--     cualquier cuenta registrada podia listar TODAS las reservas y pedidos con correos y telefonos.
--   * "Users can view own reservations." tenia rota la parte de invitados:
--     jsonb_array_elements_text(guest_data -> 'user_id') sobre un ARREGLO da NULL, asi que ningun invitado
--     registrado veia su reserva por RLS (42 de 47 reservas tienen invitado registrado en guest_data[*].user_id).
--   * INSERT/UPDATE estaban para el rol "public" y el UPDATE no tenia WITH CHECK.
--   * Grants actuales: authenticated = INSERT, SELECT, UPDATE; service_role = todo; anon = nada. No cambian
--     (ya son el minimo que las policies usan); se dejan explicitos y se revoca todo a anon/PUBLIC.
--
-- Efecto sobre Realtime (postgres_changes en /reservations/[id] y /orders/[id]): usa estas mismas policies de
-- SELECT. Los invitados registrados pasan a recibir actualizaciones en vivo (antes no); quien no esta
-- relacionado con el ticket deja de recibirlas.
--
-- Regla de invitado = misma de isRelatedToTicket (pwa/src/lib/ticket-viewer-token.ts): guest_data[*].user_id,
-- con `guests` de respaldo cuando guest_data no trae un arreglo con datos. Staff del restaurante, admin y
-- public-tickets leen con service_role (bypass de RLS): no cambian.
--
-- Sin tablas nuevas -> sin GRANT de tabla nuevos (CLAUDE.md sec. 6).

BEGIN;

-- 1) Cerrar la lectura por codigo ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated access by unique_code" ON public.reservations;
DROP POLICY IF EXISTS "Authenticated access by unique_code" ON public.takeaway_orders;

-- 2) reservations ---------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own reservations." ON public.reservations;
CREATE POLICY "Users can view own reservations." ON public.reservations
    FOR SELECT TO authenticated
    USING (
        (SELECT auth.uid()) = organizer_id
        OR (SELECT auth.uid()) = user_id
        OR jsonb_path_exists(
            CASE WHEN jsonb_typeof(guest_data) = 'array' AND jsonb_array_length(guest_data) > 0
                 THEN guest_data ELSE guests END,
            '$[*] ? (@.user_id == $uid)',
            jsonb_build_object('uid', ((SELECT auth.uid()))::text)
        )
    );

DROP POLICY IF EXISTS "Users can create reservations." ON public.reservations;
CREATE POLICY "Users can create reservations." ON public.reservations
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT auth.uid()) = organizer_id);

DROP POLICY IF EXISTS "Users can update own reservations." ON public.reservations;
CREATE POLICY "Users can update own reservations." ON public.reservations
    FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = organizer_id)
    WITH CHECK ((SELECT auth.uid()) = organizer_id);

-- 3) takeaway_orders ------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own orders." ON public.takeaway_orders;
CREATE POLICY "Users can view own orders." ON public.takeaway_orders
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create orders." ON public.takeaway_orders;
CREATE POLICY "Users can create orders." ON public.takeaway_orders
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own orders." ON public.takeaway_orders;
CREATE POLICY "Users can update own orders." ON public.takeaway_orders
    FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = user_id)
    WITH CHECK ((SELECT auth.uid()) = user_id);

-- 4) GRANT explicitos y minimos -----------------------------------------------------------------------------
REVOKE ALL ON public.reservations    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.takeaway_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reservations    TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.takeaway_orders TO authenticated;
GRANT ALL ON public.reservations    TO service_role;
GRANT ALL ON public.takeaway_orders TO service_role;

COMMIT;

-- ROLLBACK (restaura el estado del 2026-10-04; reabre la lectura por codigo, usar solo en emergencia):
-- BEGIN;
-- DROP POLICY IF EXISTS "Users can view own reservations." ON public.reservations;
-- DROP POLICY IF EXISTS "Users can create reservations." ON public.reservations;
-- DROP POLICY IF EXISTS "Users can update own reservations." ON public.reservations;
-- DROP POLICY IF EXISTS "Users can view own orders." ON public.takeaway_orders;
-- DROP POLICY IF EXISTS "Users can create orders." ON public.takeaway_orders;
-- DROP POLICY IF EXISTS "Users can update own orders." ON public.takeaway_orders;
-- CREATE POLICY "Authenticated access by unique_code" ON public.reservations FOR SELECT TO authenticated USING (unique_code IS NOT NULL);
-- CREATE POLICY "Authenticated access by unique_code" ON public.takeaway_orders FOR SELECT TO authenticated USING (unique_code IS NOT NULL);
-- CREATE POLICY "Users can view own reservations." ON public.reservations FOR SELECT TO public
--   USING ((auth.uid() = organizer_id) OR (auth.uid() = user_id) OR ((auth.uid())::text = ANY (ARRAY(SELECT jsonb_array_elements_text((reservations.guest_data -> 'user_id'::text))))));
-- CREATE POLICY "Users can create reservations." ON public.reservations FOR INSERT TO public WITH CHECK (auth.uid() = organizer_id);
-- CREATE POLICY "Users can update own reservations." ON public.reservations FOR UPDATE TO public USING (auth.uid() = organizer_id);
-- CREATE POLICY "Users can view own orders." ON public.takeaway_orders FOR SELECT TO public USING (auth.uid() = user_id);
-- CREATE POLICY "Users can create orders." ON public.takeaway_orders FOR INSERT TO public WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "Users can update own orders." ON public.takeaway_orders FOR UPDATE TO public USING (auth.uid() = user_id);
-- (Los GRANT no cambian de efecto: authenticated conserva INSERT/SELECT/UPDATE, service_role todo, anon nada.)
-- COMMIT;
