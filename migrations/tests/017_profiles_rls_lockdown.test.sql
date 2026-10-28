-- Prueba de 017 (correr en una base de desarrollo/local con la migración aplicada, NO en producción).
-- Todo dentro de una transacción con ROLLBACK. Reemplazar los UUID por 2 usuarios USER y 1 SUPER_ADMIN reales.
BEGIN;
\set u1 '''00000000-0000-0000-0000-000000000001'''
\set u2 '''00000000-0000-0000-0000-000000000002'''
\set sa '''00000000-0000-0000-0000-0000000000aa'''

-- anon: sin acceso
SET LOCAL ROLE anon;
DO $$ BEGIN PERFORM 1 FROM public.profiles LIMIT 1; RAISE EXCEPTION 'FALLO: anon pudo leer profiles';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- usuario normal: solo su fila
RESET ROLE; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :u1, 'role', 'authenticated')::text, true);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.profiles) <> 1 THEN RAISE EXCEPTION 'FALLO: authenticated ve <> 1 fila'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000002') THEN RAISE EXCEPTION 'FALLO: ve fila ajena'; END IF;
END $$;
-- puede editar columnas permitidas
UPDATE public.profiles SET first_name = first_name WHERE id = :u1;
-- no puede escalar privilegios
DO $$ BEGIN UPDATE public.profiles SET role = 'SUPER_ADMIN' WHERE id = '00000000-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'FALLO: pudo cambiar role'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN UPDATE public.profiles SET reservation_reputation = 100 WHERE id = '00000000-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'FALLO: pudo cambiar reputación'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
-- no puede insertar perfil con rol elevado
DO $$ BEGIN INSERT INTO public.profiles (id, role, account_type) VALUES (gen_random_uuid(), 'ADMIN', 'free');
  RAISE EXCEPTION 'FALLO: insert con role ADMIN'; EXCEPTION WHEN insufficient_privilege OR check_violation OR foreign_key_violation THEN NULL; END $$;

-- super admin: ve todo
RESET ROLE; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :sa, 'role', 'authenticated')::text, true);
DO $$ BEGIN IF (SELECT count(*) FROM public.profiles) < 2 THEN RAISE EXCEPTION 'FALLO: super admin no ve todos'; END IF; END $$;

RESET ROLE;
-- triggers de auto-aprobación deben ser SECURITY DEFINER
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('auto_approve_reservation','auto_approve_takeaway_order') AND NOT prosecdef)
  THEN RAISE EXCEPTION 'FALLO: trigger auto_approve sigue SECURITY INVOKER'; END IF;
END $$;
ROLLBACK;
