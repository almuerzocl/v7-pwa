-- 051_contact_identities.sql   (REDACTADA, NO APLICADA)
-- Registro propio de identidades de contacto: el correo que un INVITADO deja para recibir avisos vive aquí y en ningún
-- otro lugar legible por el organizador.
--
-- Decisiones del usuario (2026-10-30):
--   * el organizador NUNCA ve el correo que el invitado dejó; su agenda (contacts) apunta a la identidad con un id opaco;
--   * un solo texto de consentimiento cubre los avisos de esa reserva y las futuras invitaciones de quien lo invitó;
--   * las invitaciones futuras al mismo contacto salen directo al correo guardado, con enlace para bloquear a ese organizador
--     o darse de baja de todo;
--   * el invitado puede pedir que se borre su dato (erase_contact_identity).
--
-- Qué NO hace: no envía correos, no cambia el emisor de invitaciones y no migra datos existentes. El emisor deberá resolver el
-- correo con resolve_identity_email() al enviar (no copiarlo a guest_data: ahí lo leería el organizador). Eso es la parte D.
--
-- Quién las usa: SOLO service_role (rutas de servidor de public-tickets y de la PWA). Ninguna tabla ni función es accesible
-- para anon ni authenticated; contacts.identity_id además queda protegido por un trigger (el cliente no puede fijarlo).
--
-- Antes de aplicar (base ÚNICA: afecta a producción): dry-run con DO … RAISE EXCEPTION, y después verificar role_table_grants y
-- proacl en la base real (Supabase da a service_role TODOS los privilegios en tablas nuevas: el REVOKE explícito de abajo importa).
-- Orden de despliegue: esta migración → public-tickets (ruta /api/rsvp-contact llama a register_guest_contact). Nunca al revés.

-- ───────────── 1. Identidades ─────────────
CREATE TABLE IF NOT EXISTS public.contact_identities (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email_norm  text NOT NULL,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'bounced', 'unsubscribed')),
    user_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contact_identities_email_chk CHECK (
        email_norm = lower(btrim(email_norm)) AND length(email_norm) <= 254 AND email_norm ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_identities_email_key ON public.contact_identities (email_norm);
CREATE INDEX IF NOT EXISTS contact_identities_user_idx ON public.contact_identities (user_id) WHERE user_id IS NOT NULL;
ALTER TABLE public.contact_identities ENABLE ROW LEVEL SECURITY;  -- sin policies: solo service_role (bypassa RLS)

-- ───────────── 2. Consentimientos (solo se agregan) ─────────────
CREATE TABLE IF NOT EXISTS public.contact_consents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_id     uuid NOT NULL REFERENCES public.contact_identities(id) ON DELETE CASCADE,
    organizer_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    reservation_id  uuid REFERENCES public.reservations(id) ON DELETE SET NULL,
    guest_id        text,
    scope           text[] NOT NULL CHECK (cardinality(scope) > 0 AND scope <@ ARRAY['avisos_reserva', 'futuras_invitaciones']),
    version         text NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 64),
    accepted_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_consents_identity_idx ON public.contact_consents (identity_id);
CREATE INDEX IF NOT EXISTS contact_consents_organizer_idx ON public.contact_consents (organizer_id) WHERE organizer_id IS NOT NULL;
ALTER TABLE public.contact_consents ENABLE ROW LEVEL SECURITY;

-- ───────────── 3. Bloqueos: «no quiero invitaciones de este organizador» ─────────────
CREATE TABLE IF NOT EXISTS public.contact_identity_blocks (
    identity_id   uuid NOT NULL REFERENCES public.contact_identities(id) ON DELETE CASCADE,
    organizer_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (identity_id, organizer_id)
);
ALTER TABLE public.contact_identity_blocks ENABLE ROW LEVEL SECURITY;

-- ───────────── 4. La agenda del organizador apunta a la identidad (id opaco; no hay forma de leer la tabla) ─────────────
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS identity_id uuid REFERENCES public.contact_identities(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_owner_identity_key ON public.contacts (owner_id, identity_id) WHERE identity_id IS NOT NULL;

-- contacts es editable por su dueño (policy «Users can manage own contacts»): el cliente no puede fijar ni cambiar identity_id.
CREATE OR REPLACE FUNCTION public.contacts_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
    IF public.inventory_caller_role() IN ('anon', 'authenticated') THEN
        IF TG_OP = 'INSERT' AND NEW.identity_id IS NOT NULL THEN
            RAISE EXCEPTION 'identity_id no se puede fijar desde el cliente' USING ERRCODE = '42501', HINT = 'identity_forbidden';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.identity_id IS DISTINCT FROM OLD.identity_id THEN
            RAISE EXCEPTION 'identity_id no se puede cambiar desde el cliente' USING ERRCODE = '42501', HINT = 'identity_forbidden';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS tr_00_contacts_identity_guard ON public.contacts;
CREATE TRIGGER tr_00_contacts_identity_guard BEFORE INSERT OR UPDATE ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.contacts_identity_guard();

-- ───────────── 5. Registrar el contacto de un invitado (lo llama public-tickets /api/rsvp-contact) ─────────────
-- Todo en una transacción: identidad + consentimiento + marca en el invitado + contacto del organizador.
-- El correo NUNCA se escribe en guest_data ni se devuelve. Si no llega p_email se usa el de la invitación (guest_data.email).
CREATE OR REPLACE FUNCTION public.register_guest_contact(
    p_reservation_id uuid, p_guest_id text, p_email text, p_version text,
    p_scope text[] DEFAULT ARRAY['avisos_reserva', 'futuras_invitaciones'])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    r reservations%ROWTYPE;
    v_guest jsonb;
    v_email text;
    v_identity uuid;
    v_contact uuid;
    v_created boolean := false;
    v_blocked boolean := false;
    v_has_account boolean := false;
    v_name text; v_first text; v_last text;
    v_patch jsonb;
BEGIN
    IF p_version IS NULL OR length(btrim(p_version)) NOT BETWEEN 1 AND 64 THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_version', 'error', 'Falta la versión del consentimiento');
    END IF;
    IF p_scope IS NULL OR cardinality(p_scope) = 0 OR NOT (p_scope <@ ARRAY['avisos_reserva', 'futuras_invitaciones']) THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_scope', 'error', 'Alcance de consentimiento no válido');
    END IF;

    SELECT * INTO r FROM reservations WHERE id = p_reservation_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'not_found', 'error', 'Reservation not found'); END IF;
    IF r.status = 'PENDIENTE' THEN
        RETURN jsonb_build_object('success', false, 'code', 'not_confirmed', 'error', 'La reserva aún no está confirmada por el restaurante.');
    ELSIF r.status <> 'CONFIRMADA' THEN
        RETURN jsonb_build_object('success', false, 'code', 'closed', 'error', 'Esta reserva ya no admite respuestas.');
    END IF;

    SELECT e INTO v_guest FROM jsonb_array_elements(COALESCE(r.guest_data, '[]'::jsonb)) e WHERE e->>'id' = p_guest_id LIMIT 1;
    IF v_guest IS NULL THEN RETURN jsonb_build_object('success', false, 'code', 'guest_not_found', 'error', 'Guest not found in reservation'); END IF;
    IF COALESCE((v_guest->>'is_organizer')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'code', 'organizer', 'error', 'El organizador gestiona sus avisos desde la app');
    END IF;

    v_email := lower(btrim(COALESCE(NULLIF(btrim(p_email), ''), v_guest->>'email', '')));
    IF v_email = '' THEN RETURN jsonb_build_object('success', false, 'code', 'email_required', 'error', 'Falta un correo'); END IF;
    IF length(v_email) > 254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_email', 'error', 'Correo no válido');
    END IF;

    -- Identidad: un correo = una identidad. Un nuevo consentimiento reactiva una baja o un rebote previos.
    INSERT INTO contact_identities (email_norm) VALUES (v_email)
    ON CONFLICT (email_norm) DO UPDATE SET status = 'active', updated_at = now()
    RETURNING id INTO v_identity;
    -- ¿Tiene cuenta? Solo se sabe por el correo que el propio invitado entregó.
    UPDATE contact_identities ci SET user_id = p.id
      FROM (SELECT id FROM profiles WHERE lower(btrim(email)) = v_email LIMIT 1) p
     WHERE ci.id = v_identity AND ci.user_id IS DISTINCT FROM p.id;
    SELECT (user_id IS NOT NULL) INTO v_has_account FROM contact_identities WHERE id = v_identity;

    INSERT INTO contact_consents (identity_id, organizer_id, reservation_id, guest_id, scope, version)
    VALUES (v_identity, r.organizer_id, r.id, p_guest_id, p_scope, btrim(p_version));

    -- Marca en el invitado: solo ids y fechas (nada que identifique al correo). Se limpia cualquier notify_email antiguo.
    v_patch := jsonb_build_object('identity_id', v_identity, 'notify_consent_at', now(), 'notify_consent_version', btrim(p_version));
    UPDATE reservations SET guest_data = (
        SELECT jsonb_agg(CASE WHEN e->>'id' = p_guest_id THEN (e - 'notify_email') || v_patch ELSE e END ORDER BY ord)
          FROM jsonb_array_elements(r.guest_data) WITH ORDINALITY AS t(e, ord)
    ) WHERE id = r.id;

    -- Agenda del organizador (si el invitado lo bloqueó antes, no se le agrega).
    SELECT EXISTS (SELECT 1 FROM contact_identity_blocks WHERE identity_id = v_identity AND organizer_id = r.organizer_id) INTO v_blocked;
    IF NOT v_blocked AND r.organizer_id IS NOT NULL THEN
        SELECT id INTO v_contact FROM contacts WHERE owner_id = r.organizer_id AND identity_id = v_identity;
        IF v_contact IS NULL AND p_guest_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            -- En el wizard el id del invitado ES el id del contacto de la agenda.
            UPDATE contacts SET identity_id = v_identity
             WHERE id = p_guest_id::uuid AND owner_id = r.organizer_id AND identity_id IS NULL
            RETURNING id INTO v_contact;
        END IF;
        IF v_contact IS NULL THEN
            UPDATE contacts SET identity_id = v_identity
             WHERE id = (SELECT id FROM contacts WHERE owner_id = r.organizer_id AND identity_id IS NULL AND lower(btrim(email)) = v_email
                          ORDER BY created_at LIMIT 1)
            RETURNING id INTO v_contact;
        END IF;
        IF v_contact IS NULL THEN
            v_name := btrim(COALESCE(v_guest->>'name', ''));
            v_first := COALESCE(NULLIF(split_part(v_name, ' ', 1), ''), 'Invitado');
            v_last := btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1));
            INSERT INTO contacts (owner_id, first_name, last_name, email, whatsapp_phone, identity_id)
            VALUES (r.organizer_id, v_first, v_last, NULL, NULL, v_identity)
            ON CONFLICT (owner_id, identity_id) WHERE identity_id IS NOT NULL DO NOTHING
            RETURNING id INTO v_contact;
            v_created := v_contact IS NOT NULL;
            IF v_contact IS NULL THEN SELECT id INTO v_contact FROM contacts WHERE owner_id = r.organizer_id AND identity_id = v_identity; END IF;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'identity_id', v_identity, 'contact_id', v_contact, 'contact_created', v_created,
                              'blocked', v_blocked, 'has_account', v_has_account);
END;
$function$;

-- ───────────── 6. Lo que necesitará el emisor y la agenda (parte D) ─────────────
-- Correo para ENVIAR una invitación: solo si la identidad está activa y no bloqueó a ese organizador. Si no, NULL.
CREATE OR REPLACE FUNCTION public.resolve_identity_email(p_identity uuid, p_organizer uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
    SELECT i.email_norm
      FROM contact_identities i
     WHERE i.id = p_identity AND i.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM contact_identity_blocks b WHERE b.identity_id = i.id AND b.organizer_id = p_organizer);
$function$;

-- Estado de cada contacto del organizador SIN mostrar correos: ¿recibe invitaciones?, ¿tiene cuenta? (solo si el propio invitado dio su correo).
CREATE OR REPLACE FUNCTION public.contact_invite_status(p_owner uuid)
RETURNS TABLE (contact_id uuid, receives_invites boolean, has_account boolean)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
    SELECT c.id,
           (COALESCE(btrim(c.email), '') <> '')
             OR (i.id IS NOT NULL AND i.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM contact_identity_blocks b WHERE b.identity_id = i.id AND b.organizer_id = c.owner_id)),
           COALESCE(i.user_id IS NOT NULL, false)
      FROM contacts c LEFT JOIN contact_identities i ON i.id = c.identity_id
     WHERE c.owner_id = p_owner;
$function$;

-- Baja: 'all' = no más correos de nadie; 'organizer' = no más invitaciones de ese organizador (los avisos de reservas ya aceptadas siguen).
CREATE OR REPLACE FUNCTION public.contact_identity_unsubscribe(p_identity uuid, p_scope text, p_organizer uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
    IF p_scope = 'all' THEN
        UPDATE contact_identities SET status = 'unsubscribed', updated_at = now() WHERE id = p_identity;
        IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'not_found'); END IF;
    ELSIF p_scope = 'organizer' AND p_organizer IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM contact_identities WHERE id = p_identity) THEN RETURN jsonb_build_object('success', false, 'code', 'not_found'); END IF;
        INSERT INTO contact_identity_blocks (identity_id, organizer_id) VALUES (p_identity, p_organizer) ON CONFLICT DO NOTHING;
    ELSE
        RETURN jsonb_build_object('success', false, 'code', 'invalid_scope');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$function$;

-- Derecho a borrar: elimina la identidad (y por cascada sus consentimientos y bloqueos), suelta el vínculo de las agendas y quita de
-- guest_data las marcas que apuntaban a ella. NO borra correos que un organizador escribió él mismo en sus reservas o contactos: son
-- datos del organizador y se tratan con la retención de reservas.
CREATE OR REPLACE FUNCTION public.erase_contact_identity(p_identity uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_cleaned integer := 0; v_deleted integer := 0;
BEGIN
    UPDATE reservations SET guest_data = (
        SELECT jsonb_agg(CASE WHEN e->>'identity_id' = p_identity::text
                              THEN e - 'identity_id' - 'notify_consent_at' - 'notify_consent_version' - 'notify_email' ELSE e END ORDER BY ord)
          FROM jsonb_array_elements(guest_data) WITH ORDINALITY AS t(e, ord))
     WHERE guest_data @> jsonb_build_array(jsonb_build_object('identity_id', p_identity::text));
    GET DIAGNOSTICS v_cleaned = ROW_COUNT;
    DELETE FROM contact_identities WHERE id = p_identity;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN jsonb_build_object('success', true, 'reservations_cleaned', v_cleaned, 'identity_deleted', v_deleted = 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.erase_contact_identity_by_email(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
    SELECT id INTO v_id FROM contact_identities WHERE email_norm = lower(btrim(p_email));
    IF v_id IS NULL THEN RETURN jsonb_build_object('success', true, 'reservations_cleaned', 0, 'identity_deleted', false); END IF;
    RETURN public.erase_contact_identity(v_id);
END;
$function$;

-- ───────────── 7. Permisos mínimos (CLAUDE.md §6): solo service_role, sin lo que no necesita ─────────────
REVOKE ALL ON TABLE public.contact_identities, public.contact_consents, public.contact_identity_blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contact_identities TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.contact_consents TO service_role;          -- sin UPDATE: el registro de consentimiento no se edita
GRANT SELECT, INSERT, DELETE ON TABLE public.contact_identity_blocks TO service_role;
REVOKE UPDATE ON TABLE public.contact_consents, public.contact_identity_blocks FROM service_role;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.contact_identities, public.contact_consents, public.contact_identity_blocks FROM service_role;

REVOKE ALL ON FUNCTION public.register_guest_contact(uuid, text, text, text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_identity_email(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contact_invite_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contact_identity_unsubscribe(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erase_contact_identity(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erase_contact_identity_by_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contacts_identity_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_guest_contact(uuid, text, text, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_identity_email(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.contact_invite_status(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.contact_identity_unsubscribe(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.erase_contact_identity(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.erase_contact_identity_by_email(text) TO service_role;
