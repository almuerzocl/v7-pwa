-- 042: correo de bienvenida a comensales nuevos (con enlace personal a la encuesta tuopinion.almuerzo.cl).
--
-- REDACTADA, NO APLICADA. Orden de despliegue: aplicar ANTES de desplegar el emisor (el cron llama a claim_welcome_emails()).
--
-- Regla: se envia UNA sola vez, solo a comensales nuevos (profiles.role = 'USER') cuyo registro ya esta confirmado y que
-- ya iniciaron sesion en la PWA; no a usuarios existentes (backfill) ni a personal de restaurantes (rol distinto de USER).
-- Una cuenta creada por el personal (reserva manual) solo recibe la bienvenida si despues inicia sesion en los primeros 14 dias.
-- Emisor: PWA (src/lib/server/welcome-email-job.ts), dentro del cron `pwa-reservation-confirmations` (cada minuto).
-- El emisor ademas exige WELCOME_EMAILS_ENABLED=true: aplicar esta migracion NO activa ningun envio.
--
-- Tabla nueva public.welcome_emails (estado de envio; no guarda tokens, enlaces ni secretos):
--   sent_at     marca de "ya enviado" (NULL = pendiente)
--   attempts    intentos hechos (tope 5 en el reclamo)
--   claimed_at  reclamo con vencimiento de 5 min (recupera un proceso caido)
--   last_error  ultimo error de envio, truncado (sin enlaces)
-- GRANT: solo service_role (la tabla no se expone a anon ni authenticated; RLS activa sin policies).
-- Trigger AFTER INSERT en profiles (SECURITY DEFINER, EXECUTE revocado: solo lo dispara el trigger) encola al comensal nuevo.
-- claim_welcome_emails(): SECURITY DEFINER porque lee auth.users (service_role no tiene SELECT ahi); EXECUTE solo service_role.
--
-- VERIFICACION (despues de aplicar):
--   select count(*) total, count(*) filter (where sent_at is not null) marcadas from welcome_emails;  -- marcadas = total (39 al 2026-10-25)
--   select grantee, privilege_type from information_schema.role_table_grants where table_name='welcome_emails'; -- solo service_role
--   select has_function_privilege('anon','public.claim_welcome_emails(integer,uuid)','execute'),
--          has_function_privilege('authenticated','public.claim_welcome_emails(integer,uuid)','execute'),
--          has_function_privilege('service_role','public.claim_welcome_emails(integer,uuid)','execute');  -- false, false, true
-- ROLLBACK:
--   drop trigger if exists tr_enqueue_welcome_email on public.profiles;
--   drop function if exists public.enqueue_welcome_email();
--   drop function if exists public.claim_welcome_emails(integer, uuid);
--   drop table if exists public.welcome_emails;

CREATE TABLE IF NOT EXISTS public.welcome_emails (
    user_id    uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz,
    attempts   integer NOT NULL DEFAULT 0,
    claimed_at timestamptz,
    last_error text
);

ALTER TABLE public.welcome_emails ENABLE ROW LEVEL SECURITY;

-- Supabase otorga por defecto TODOS los privilegios a anon/authenticated/service_role en tablas nuevas (verificado en dry-run:
-- service_role traia DELETE/TRUNCATE/REFERENCES/TRIGGER): se revoca todo y se deja explicito el minimo privilegio.
REVOKE ALL ON TABLE public.welcome_emails FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.welcome_emails TO service_role;

-- Backfill: TODOS los perfiles existentes quedan como "ya atendidos" (sin correos retroactivos).
INSERT INTO public.welcome_emails (user_id, sent_at)
SELECT id, now() FROM public.profiles
ON CONFLICT (user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_welcome_emails_pending
    ON public.welcome_emails (created_at)
    WHERE sent_at IS NULL;

CREATE OR REPLACE FUNCTION public.enqueue_welcome_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF NEW.role = 'USER' THEN
        INSERT INTO public.welcome_emails (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_welcome_email() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tr_enqueue_welcome_email ON public.profiles;
CREATE TRIGGER tr_enqueue_welcome_email
    AFTER INSERT ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.enqueue_welcome_email();

-- Reclamo atomico (FOR UPDATE SKIP LOCKED): dos ejecuciones simultaneas no reclaman la misma fila.
CREATE OR REPLACE FUNCTION public.claim_welcome_emails(p_limit integer DEFAULT 20, p_user uuid DEFAULT NULL)
 RETURNS TABLE (user_id uuid, email text, first_name text, attempts integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
    WITH claimed AS (
        UPDATE public.welcome_emails w
           SET claimed_at = now(),
               attempts = w.attempts + 1
         WHERE w.user_id IN (
            SELECT c.user_id
              FROM public.welcome_emails c
              JOIN public.profiles p ON p.id = c.user_id
              JOIN auth.users u ON u.id = c.user_id
             WHERE c.sent_at IS NULL
               AND c.attempts < 5
               AND c.created_at > now() - interval '14 days'
               AND (c.claimed_at IS NULL OR c.claimed_at < now() - interval '5 minutes')
               AND p.role = 'USER'
               AND u.email_confirmed_at IS NOT NULL
               AND u.last_sign_in_at IS NOT NULL
               AND (p_user IS NULL OR c.user_id = p_user)
             ORDER BY c.created_at
             LIMIT GREATEST(p_limit, 1)
             FOR UPDATE OF c SKIP LOCKED
         )
        RETURNING w.user_id, w.attempts
    )
    SELECT cl.user_id,
           COALESCE(NULLIF(p.email, ''), u.email)::text,
           p.first_name::text,
           cl.attempts
      FROM claimed cl
      JOIN public.profiles p ON p.id = cl.user_id
      JOIN auth.users u ON u.id = cl.user_id;
$function$;

REVOKE ALL ON FUNCTION public.claim_welcome_emails(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_welcome_emails(integer, uuid) TO service_role;
