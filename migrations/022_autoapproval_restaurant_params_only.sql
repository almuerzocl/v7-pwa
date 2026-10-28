-- 022: aprobacion automatica -- el UNICO decisor son los parametros del restaurante.
--
-- Regla de negocio (confirmada por el usuario el 2026-10-02): reservas y pedidos para llevar solo se
-- aprueban automaticamente segun los parametros del restaurante (panel de configuracion del Restaurant
-- Dashboard = unica fuente de verdad): reservation_settings.max_party_size + min_reputation y
-- takeaway_settings.max_order_amount + min_reputation. Ambos criterios son CONCURRENTES; si falla uno
-- o el restaurante no tiene el parametro guardado, la orden queda PENDIENTE para aprobacion manual.
-- La plataforma no decide con valores propios.
--
-- Antes: ambos triggers usaban COALESCE(..., 10 / 80 / 150000) cuando faltaba la clave (valores de
-- plataforma). Hoy los 6 restaurantes tienen sus parametros guardados, asi que NO cambia ninguna
-- decision existente; solo cierra el caso de un restaurante sin parametros.
--
-- Base: definiciones reales leidas con pg_get_functiondef en produccion el 2026-10-02. SOLO se quitan
-- los COALESCE y se agrega el retorno anticipado si falta algun parametro; el resto queda IDENTICO
-- (incluida la validacion de identidad/reputacion 0..100 de 009 y 011, y el uso de NEW.user_id en
-- reservas: hoy siempre NULL -> reputacion 0 -> el trigger de reservas no aprueba; la aprobacion
-- automatica de reservas la ejecuta la PWA con los mismos parametros, ver reservation-create-action.ts).
-- Sin cambios de GRANT (CREATE OR REPLACE conserva los existentes: solo postgres y service_role).

CREATE OR REPLACE FUNCTION public.auto_approve_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

    v_max_pax := (v_settings->>'max_party_size')::integer;
    v_min_reputation := (v_settings->>'min_reputation')::integer;

    -- Sin parametros del restaurante no se aprueba automaticamente (queda PENDIENTE).
    IF v_max_pax IS NULL OR v_min_reputation IS NULL THEN
        RETURN NEW;
    END IF;

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

CREATE OR REPLACE FUNCTION public.auto_approve_takeaway_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_settings jsonb;
    v_max_amount numeric;
    v_min_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
BEGIN
    IF NEW.user_id IS NULL THEN
        RAISE EXCEPTION 'takeaway_orders: user_id es obligatorio (toda transaccion requiere identificacion)'
            USING ERRCODE = 'not_null_violation';
    END IF;

    SELECT takeaway_reputation, reservation_reputation
      INTO v_takeaway_reputation, v_reservation_reputation
      FROM public.profiles WHERE id = NEW.user_id;

    IF v_takeaway_reputation IS NULL OR v_reservation_reputation IS NULL
       OR v_takeaway_reputation NOT BETWEEN 0 AND 100
       OR v_reservation_reputation NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'takeaway_orders: el usuario % no tiene reputacion valida (0-100) en todos sus ambitos', NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT takeaway_settings INTO v_settings FROM public.restaurants WHERE id = NEW.restaurant_id;
    IF v_settings IS NULL THEN RETURN NEW; END IF;

    v_max_amount := (v_settings->>'max_order_amount')::numeric;
    v_min_reputation := (v_settings->>'min_reputation')::integer;

    -- Sin parametros del restaurante no se aprueba automaticamente (queda PENDIENTE).
    IF v_max_amount IS NULL OR v_min_reputation IS NULL THEN RETURN NEW; END IF;

    IF (NEW.status IN ('PENDIENTE', 'CREADA')) AND NEW.total_amount <= v_max_amount AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;
