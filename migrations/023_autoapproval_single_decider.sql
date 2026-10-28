-- 023: aprobacion automatica -- un unico decisor en la BD, mismos criterios para reservas y pedidos.
--
-- Regla de negocio (confirmada por el usuario el 2026-10-02): el UNICO decisor son los parametros del
-- restaurante (panel de configuracion del Restaurant Dashboard). Criterios CONCURRENTES: si falla uno o
-- falta un parametro, la orden queda PENDIENTE para aprobacion manual.
--   Reservas : reservation_settings.max_party_size + min_reputation  vs party_size y reservation_reputation
--   Pedidos  : takeaway_settings.max_order_amount + max_items + min_reputation
--              vs total_amount, unidades del pedido y takeaway_reputation
--
-- Cambios respecto de 022 (base: definiciones reales de produccion, leidas el 2026-10-02):
--  1. auto_approve_reservation: la reputacion que se compara es la del ORGANIZADOR
--     (profiles.reservation_reputation de NEW.organizer_id, ya leida en el bloque de validacion). Antes
--     leia NEW.user_id (siempre NULL en las reservas de la PWA) -> reputacion 0 -> el trigger nunca
--     aprobaba y la aprobacion la hacia la PWA con otro codigo. Ahora el trigger es el unico decisor
--     (igual que en pedidos) y deja el rastro: status, approved_at, confirmed_at y
--     timestamps->'CONFIRMADA' (actor_role 'system' + motivo) y la notificacion in-app al cliente
--     ("Tu reserva ha sido confirmada"), como lo hacia transition_status. La notificacion no es
--     bloqueante: si fallara, la reserva se crea igual (se registra un WARNING).
--  2. auto_approve_takeaway_order: tercer criterio concurrente, takeaway_settings.max_items = maximo de
--     UNIDADES del pedido (suma de quantity de items; cantidad ausente cuenta 1). Sin max_items guardado
--     no se aprueba (todos los restaurantes lo tienen hoy: 15, default de la columna).
-- Sin cambios de GRANT (CREATE OR REPLACE conserva los existentes: solo postgres y service_role).
-- Orden de despliegue: aplicar ANTES de desplegar la PWA que deja de aprobar reservas.

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
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
    v_restaurant_name text;
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

    -- Ambos criterios son concurrentes.
    IF NEW.status = 'PENDIENTE' AND
       NEW.party_size <= v_max_pax AND
       v_reservation_reputation >= v_min_reputation THEN

        NEW.status := 'CONFIRMADA';
        NEW.approved_at := now();
        NEW.confirmed_at := now();
        NEW.timestamps := COALESCE(NEW.timestamps, '{}'::jsonb) || jsonb_build_object(
            'CONFIRMADA', jsonb_build_object(
                'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'actor_id', NEW.organizer_id::text,
                'actor_role', 'system',
                'reason', format('Auto-aprobada: reputacion %s >= %s, grupo %s <= %s',
                                 v_reservation_reputation, v_min_reputation, NEW.party_size, v_max_pax)
            )
        );

        -- Notificacion in-app al cliente (mismo contenido que transition_status para CONFIRMADA).
        BEGIN
            SELECT name INTO v_restaurant_name FROM public.restaurants WHERE id = NEW.restaurant_id;
            INSERT INTO public.notifications (user_id, restaurant_id, type, title, message, related_id, priority, actor_id, actor_role)
            VALUES (NEW.organizer_id, NEW.restaurant_id, 'RESERVATION', COALESCE(v_restaurant_name, 'Restaurante'),
                    'Tu reserva ha sido confirmada', NEW.id, 'NORMAL', NEW.organizer_id, 'system');
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'auto_approve_reservation: no se pudo crear la notificacion (%): %', SQLSTATE, SQLERRM;
        END;
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
    v_max_items integer;
    v_min_reputation integer;
    v_takeaway_reputation integer;
    v_reservation_reputation integer;
    v_items jsonb;
    v_units integer := 0;
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
    v_max_items := (v_settings->>'max_items')::integer;
    v_min_reputation := (v_settings->>'min_reputation')::integer;

    -- Sin parametros del restaurante no se aprueba automaticamente (queda PENDIENTE).
    IF v_max_amount IS NULL OR v_max_items IS NULL OR v_min_reputation IS NULL THEN RETURN NEW; END IF;

    -- Unidades del pedido: suma de quantity (items puede venir como array o como string JSON).
    v_items := NEW.items;
    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'string' THEN
        v_items := (v_items #>> '{}')::jsonb;
    END IF;
    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'array' THEN
        SELECT COALESCE(SUM(trunc(COALESCE(NULLIF(t.e->>'quantity', '')::numeric, 1))), 0)::integer
          INTO v_units
          FROM jsonb_array_elements(v_items) AS t(e);
    END IF;

    -- Los tres criterios son concurrentes.
    IF (NEW.status IN ('PENDIENTE', 'CREADA'))
       AND NEW.total_amount <= v_max_amount
       AND v_units <= v_max_items
       AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;
