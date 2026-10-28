-- 024 — GRANTs de mínimo privilegio para anon / authenticated en `public`
-- ESTADO: APLICADA en producción el 2026-10-03 (registrada como `security_grants_least_privilege`).
-- Diferencia con el borrador: se quitó el ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin
-- (42501: el rol de migraciones no puede cambiarlo). Ver 'Deuda' al final.
--
-- Hallazgo (2026-10-02): los privilegios por defecto del esquema `public`
-- (pg_default_acl, owners postgres y supabase_admin) otorgan arwdDxtm a anon y
-- authenticated en TODA tabla nueva, y las 19 tablas actuales los heredaron.
-- RLS contiene SELECT/INSERT/UPDATE/DELETE, pero TRUNCATE no pasa por RLS: hoy `anon`
-- puede vaciar reservations, takeaway_orders, restaurants, etc.
--
-- Criterio: solo se quita lo que NINGUNA política RLS permite usar, así que el
-- comportamiento de las apps no cambia. Verificado contra pg_policies y
-- information_schema.role_table_grants reales (no contra archivos de migración).
-- `profiles` NO se toca (su lockdown es la migración 017). `service_role` no se toca.
--
-- Única excepción de comportamiento: restaurant_analytics_events tenía una política
-- ALL USING(true) para {public} (lectura/escritura anónima sin límite). Su único
-- escritor es trackAnalyticsEventAction (restaurant-dashboard, cliente con sesión =
-- authenticated); su único lector es _get_restaurant_analytics_report_impl, que es
-- SECURITY DEFINER. Pasa a: authenticated INSERT con user_id nulo o propio.

BEGIN;

-- 1) Privilegios que nunca deben tener anon/authenticated (excepto profiles, ver 017).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> 'profiles'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- 2) anon: solo lectura de lo público (ver policies SELECT {public}/{anon}).
GRANT SELECT ON public.restaurants, public.menu_items, public.reservation_blocks,
                public.reservations,            -- policy "Public access by unique_code"
                public.takeaway_orders,         -- idem
                public.daily_discount_cache, public.discount_institutions,
                public.institution_discounts
  TO anon;

-- 3) authenticated: exactamente lo que sus policies usan.
GRANT SELECT                         ON public.restaurants, public.menu_items,
                                        public.reservation_blocks, public.daily_discount_cache,
                                        public.discount_institutions, public.institution_discounts,
                                        public.user_discount_cache, public.user_institutions
  TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.reservations, public.takeaway_orders TO authenticated;
GRANT SELECT, UPDATE                 ON public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT INSERT                         ON public.restaurant_analytics_events TO authenticated;
-- Sin grants para anon/authenticated: error_logs, restaurant_payments, inventory_movements,
-- wa_cart_tokens, wa_config, wa_conversations (solo service_role, que bypassea RLS).

-- 4) restaurant_analytics_events: cerrar la política abierta.
DROP POLICY IF EXISTS "Allow service role to manage events" ON public.restaurant_analytics_events;
CREATE POLICY "Authenticated can insert own events" ON public.restaurant_analytics_events
  FOR INSERT TO authenticated
  WITH CHECK (user_id IS NULL OR user_id = auth.uid());

-- 5) Causa raíz: que las tablas NUEVAS no nazcan con acceso abierto. Cada migración con
--    CREATE TABLE debe traer sus GRANT explícitos (CLAUDE.md §6).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres      IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

COMMIT;

-- Verificación posterior (debe devolver 0 filas):
--   select grantee, table_name, privilege_type from information_schema.role_table_grants
--   where table_schema='public' and grantee in ('anon','authenticated')
--     and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER');
-- Deuda: los privilegios por defecto del owner `supabase_admin` (tablas creadas por ese rol,
-- p. ej. desde el dashboard de Supabase) siguen dando arwdDxtm a anon/authenticated. Hay que
-- cambiarlo con un rol que pueda hacerlo; mientras tanto, toda tabla nueva debe traer sus GRANT/REVOKE.
-- Rollback: GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated; (restaura el estado inseguro)
