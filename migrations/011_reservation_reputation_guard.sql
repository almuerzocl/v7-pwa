-- 011: reservas -- un usuario sin identificacion o con reputacion NULL no puede operar.
-- Contraparte de 009 (takeaway). Regla confirmada por el usuario el 2026-09-30.
--
-- IMPORTANTE (verificado en produccion): reservations.user_id es NULL en las 37 reservas y
-- create_reservation_atomic() solo escribe organizer_id. La identidad de una reserva es
-- organizer_id (NOT NULL de facto: 0 filas NULL). Por eso la validacion es sobre organizer_id;
-- exigir user_id romperia todas las reservas de la PWA.
--
-- Base: definicion real de auto_approve_reservation() leida con pg_get_functiondef el 2026-09-30.
-- SOLO se agrega el bloque de validacion al inicio. El bloque de aprobacion queda IDENTICO
-- (sigue usando NEW.user_id, que hoy siempre es NULL -> reputacion 0 -> no auto-confirma:
-- comportamiento actual que este cambio NO modifica; ver nota al final).
-- Sin cambios de GRANT (CREATE OR REPLACE conserva los existentes).

CREATE OR REPLACE FUNCTION public.auto_approve_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_settings jsonb;
    v_max_pax integer;
    v_min_reputation integer;
    v_user_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
BEGIN
    IF NEW.organizer_id IS NULL THEN
        RAISE EXCEPTION 'reservations: organizer_id es obligatorio (toda transaccion requiere identificacion)'
            USING ERRCODE = 'not_null_violation';
    END IF;

    SELECT takeaway_reputation, reservation_reputation
      INTO v_takeaway_reputation, v_reservation_reputation
      FROM public.profiles WHERE id = NEW.organizer_id;

    IF v_takeaway_reputation IS NULL OR v_reservation_reputation IS NULL
       OR v_takeaway_reputation NOT BETWEEN 0 AND 100
       OR v_reservation_reputation NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'reservations: el usuario % no tiene reputacion valida (0-100) en todos sus ambitos', NEW.organizer_id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT reservation_settings INTO v_settings
    FROM public.restaurants
    WHERE id = NEW.restaurant_id;

    IF v_settings IS NULL THEN
        RETURN NEW;
    END IF;

    v_max_pax := COALESCE((v_settings->>'max_party_size')::integer, 10);
    v_min_reputation := COALESCE((v_settings->>'min_reputation')::integer, 80);

    IF NEW.user_id IS NOT NULL THEN
        SELECT COALESCE(reservation_reputation, 100) INTO v_user_reputation
        FROM public.profiles
        WHERE id = NEW.user_id;
    ELSE
        v_user_reputation := 0;
    END IF;

    IF NEW.status = 'PENDIENTE' AND
       NEW.party_size <= v_max_pax AND
       v_user_reputation >= v_min_reputation THEN

        NEW.status := 'CONFIRMADA';
    END IF;

    RETURN NEW;
END;
$function$;

-- NOTA (fuera de alcance, requiere decision): como el bloque de aprobacion lee NEW.user_id y las
-- reservas se crean sin user_id, hoy NINGUNA reserva se auto-confirma (0 CONFIRMADA de 37).
-- Corregirlo (usar organizer_id) cambiaria el comportamiento de negocio: las reservas de usuarios
-- con reputacion >= min_reputation y party_size <= max_party_size pasarian a nacer CONFIRMADA.
