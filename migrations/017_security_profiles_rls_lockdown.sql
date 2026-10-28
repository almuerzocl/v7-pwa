-- 017_security_profiles_rls_lockdown.sql
-- Fix de seguridad CRÍTICO: cierra la lectura pública de `profiles` (email, teléfonos, reputación...).
--
-- Estado real verificado en producción (2026-09-30, kqanordhsmbtcwtjtrme):
--   * policies: "Public profiles are viewable by everyone." (SELECT true), INSERT y UPDATE con auth.uid()=id
--   * anon/authenticated con TODOS los privilegios (incl. DELETE/TRUNCATE) sobre todas las columnas
--   * ninguna policy de otra tabla ni vista referencia profiles; sin triggers sobre profiles
--   * auto_approve_reservation / auto_approve_takeaway_order (SECURITY INVOKER) leen profiles de otro usuario
--
-- ORDEN DE DESPLIEGUE (obligatorio): primero desplegar el código (pwa, admin-dashboard,
-- restaurant-dashboard) y recién después aplicar esta migración. El código nuevo funciona con ambos
-- esquemas de RLS; el código viejo NO funciona con esta migración.
--
-- Rollback: ver bloque al final (comentado).

BEGIN;

-- 1) Helper para policies de super admin (SECURITY DEFINER: evita recursión de RLS sobre profiles).
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = (SELECT auth.uid()) AND role IN ('SUPER_ADMIN', 'ROOT')
    );
$$;
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

-- 2) Los triggers de auto-aprobación leen la reputación del organizador/cliente, que puede no ser
--    quien ejecuta (staff creando reservas/pedidos manuales): deben saltarse la RLS.
ALTER FUNCTION public.auto_approve_reservation()    SECURITY DEFINER SET search_path = 'public';
ALTER FUNCTION public.auto_approve_takeaway_order() SECURITY DEFINER SET search_path = 'public';

-- 3) Policies de profiles.
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile."       ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile."             ON public.profiles;

CREATE POLICY profiles_select_own ON public.profiles
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = id);

-- El admin-dashboard lista usuarios/admins con la sesión del super admin.
CREATE POLICY profiles_select_super_admin ON public.profiles
    FOR SELECT TO authenticated
    USING (public.is_super_admin());

-- El perfil se crea desde el cliente en el primer login: solo como USER, sin restaurante,
-- cuenta free y reputación inicial (nadie puede auto-otorgarse rol ni privilegios).
CREATE POLICY profiles_insert_own ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK (
        (SELECT auth.uid()) = id
        AND role = 'USER'
        AND restaurant_id IS NULL
        AND account_type = 'free'
        AND COALESCE(reservation_reputation, 100) = 100
        AND COALESCE(takeaway_reputation, 100) = 100
    );

CREATE POLICY profiles_update_own ON public.profiles
    FOR UPDATE TO authenticated
    USING      ((SELECT auth.uid()) = id)
    WITH CHECK ((SELECT auth.uid()) = id);

-- 4) GRANTs mínimos. anon no necesita nada (nunca tiene fila propia). authenticated: SELECT/INSERT
--    y UPDATE solo de las columnas que el cliente edita (role, restaurant_id, reputación, contadores,
--    email, account_type y wa_* quedan solo para service_role).
REVOKE ALL ON public.profiles FROM anon;
REVOKE ALL ON public.profiles FROM authenticated;
GRANT SELECT, INSERT ON public.profiles TO authenticated;
GRANT UPDATE (
    first_name, last_name, display_name, photo_url, phone, phone_number,
    default_address, default_address_lat, default_address_lng,
    onboarding_completed, favorite_restaurant_ids, subscribed_daily_menu_ids,
    preferred_payment_methods, updated_at
) ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

COMMIT;

-- ROLLBACK (manual, solo si hay que revertir de urgencia; reabre la fuga):
-- BEGIN;
--   DROP POLICY profiles_select_own ON public.profiles;
--   DROP POLICY profiles_select_super_admin ON public.profiles;
--   DROP POLICY profiles_insert_own ON public.profiles;
--   DROP POLICY profiles_update_own ON public.profiles;
--   CREATE POLICY "Public profiles are viewable by everyone." ON public.profiles FOR SELECT USING (true);
--   CREATE POLICY "Users can insert their own profile." ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
--   CREATE POLICY "Users can update own profile." ON public.profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
--   GRANT ALL ON public.profiles TO anon, authenticated;
--   ALTER FUNCTION public.auto_approve_reservation() SECURITY INVOKER;
--   ALTER FUNCTION public.auto_approve_takeaway_order() SECURITY INVOKER;
-- COMMIT;
