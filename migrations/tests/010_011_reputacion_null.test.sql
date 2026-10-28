-- Pruebas de 010_profiles_reputation_not_null.sql y 011_reservation_reputation_guard.sql contra datos
-- REALES de produccion (kqanordhsmbtcwtjtrme). No deja nada: un unico DO que termina en
-- RAISE EXCEPTION, lo que revierte todo (filas, cambios en profiles y los DDL de 010/011).
-- El resultado llega como texto del error 'TEST_REPORT'. Requiere 010 y 011 NO aplicadas aun.
-- Generado a partir de 010 y 011 (bloques $m010$ / $m011$ literales).
-- Datos reales: usuario B 3adb5e10-... (take=100/res=100), restaurante 2729b647-...
DO $test$
DECLARE
    uB constant uuid := '3adb5e10-a4c8-44d3-9215-88cca7414fff';
    rid constant uuid := '2729b647-33c8-4419-8967-f668ec3ce61d';
    rep text := '';
    o record;
    n0 int; n1 int;
BEGIN
    SELECT count(*) INTO n0 FROM profiles WHERE takeaway_reputation IS NULL OR reservation_reputation IS NULL;
    rep := rep || format(E'perfiles con reputacion NULL antes: %s\n', n0);

    -- Linea base (funcion VIEJA): reserva con organizer_id NULL y con reputacion NULL se crean
    INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size)
    VALUES (rid, NULL, now() + interval '2 days', 2) RETURNING * INTO o;
    rep := rep || E'base) organizer_id NULL con funcion vieja -> CREADA (brecha)\n';

    -- 011
    EXECUTE $m011$-- 011: reservas -- un usuario sin identificacion o con reputacion NULL no puede operar.
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
$m011$;

    BEGIN
        INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size) VALUES (rid, NULL, now() + interval '2 days', 2);
        rep := rep || E'r1) organizer_id NULL -> CREADA (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'r1) organizer_id NULL -> rechazada (%s)\n', SQLSTATE); END;

    -- regresion del flujo real: organizer valido, user_id NULL (como create_reservation_atomic) -> se crea, sigue PENDIENTE
    INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size, status)
    VALUES (rid, uB, now() + interval '2 days', 2, 'PENDIENTE') RETURNING * INTO o;
    rep := rep || format(E'r2) organizer valido, user_id NULL -> status=%s (esperado PENDIENTE, igual que hoy)\n', o.status);

    UPDATE profiles SET reservation_reputation = NULL WHERE id = uB;
    BEGIN
        INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size) VALUES (rid, uB, now() + interval '2 days', 2);
        rep := rep || E'r3) reservation_reputation NULL -> CREADA (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'r3) reservation_reputation NULL -> rechazada (%s)\n', SQLSTATE); END;

    UPDATE profiles SET reservation_reputation = 100, takeaway_reputation = NULL WHERE id = uB;
    BEGIN
        INSERT INTO reservations(restaurant_id, organizer_id, date_time, party_size) VALUES (rid, uB, now() + interval '2 days', 2);
        rep := rep || E'r4) takeaway_reputation NULL -> CREADA (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'r4) takeaway_reputation NULL -> rechazada (%s)\n', SQLSTATE); END;

    UPDATE profiles SET takeaway_reputation = 100 WHERE id = uB;

    -- 010
    EXECUTE $m010$-- 010: la reputacion (takeaway y reservas) nunca puede ser NULL.
--
-- Estado real en produccion (kqanordhsmbtcwtjtrme, verificado 2026-09-30):
--   * CHECK 0..100 YA existe: profiles_takeaway_reputation_check y profiles_reservation_reputation_check.
--     (Un CHECK deja pasar NULL, por eso no bastaba.)
--   * Ambas columnas eran NULLABLE con DEFAULT 100. Los 32 perfiles tienen valores validos (0..100),
--     ninguno NULL -> SET NOT NULL es seguro, sin backfill.
-- El DEFAULT 100 se mantiene: un perfil nuevo sin valor explicito nace con reputacion 100.
-- Un UPDATE/INSERT que intente NULL falla con 23502; fuera de 0..100 falla con 23514 (CHECK existente).

ALTER TABLE public.profiles ALTER COLUMN takeaway_reputation SET NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN reservation_reputation SET NOT NULL;
$m010$;

    BEGIN UPDATE profiles SET takeaway_reputation = NULL WHERE id = uB; rep := rep || E'p1) takeaway NULL -> ACEPTADO (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'p1) takeaway NULL -> rechazado (%s)\n', SQLSTATE); END;
    BEGIN UPDATE profiles SET reservation_reputation = NULL WHERE id = uB; rep := rep || E'p2) reservation NULL -> ACEPTADO (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'p2) reservation NULL -> rechazado (%s)\n', SQLSTATE); END;
    BEGIN UPDATE profiles SET takeaway_reputation = 101 WHERE id = uB; rep := rep || E'p3) takeaway 101 -> ACEPTADO (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'p3) takeaway 101 -> rechazado (%s)\n', SQLSTATE); END;
    BEGIN UPDATE profiles SET reservation_reputation = -1 WHERE id = uB; rep := rep || E'p4) reservation -1 -> ACEPTADO (FALLA)\n';
    EXCEPTION WHEN OTHERS THEN rep := rep || format(E'p4) reservation -1 -> rechazado (%s)\n', SQLSTATE); END;
    UPDATE profiles SET takeaway_reputation = 0, reservation_reputation = 100 WHERE id = uB;
    rep := rep || E'p5) limites 0 y 100 -> aceptados\n';

    SELECT count(*) INTO n1 FROM profiles WHERE takeaway_reputation IS NULL OR reservation_reputation IS NULL;
    rep := rep || format(E'perfiles con reputacion NULL despues: %s\n', n1);

    RAISE EXCEPTION E'TEST_REPORT (transaccion revertida)\n%', rep;
END
$test$;
