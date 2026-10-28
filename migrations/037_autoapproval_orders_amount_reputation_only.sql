-- 037: aprobacion automatica de pedidos -- se retira el criterio de unidades por pedido (max_items).
--
-- Decision del usuario (2026-10-06): la autoaprobacion de pedidos queda solo con monto maximo + reputacion
-- minima (criterios concurrentes). `takeaway_settings.max_items` deja de existir como parametro.
-- Base: definicion REAL de produccion leida el 2026-10-06 con pg_get_functiondef (tiene el RAISE por user_id
-- nulo y la validacion de reputacion, que el archivo 023 no trae). Solo se quitan v_max_items, el calculo de
-- unidades (v_items / v_units), el criterio `v_units <= v_max_items` y el `IS NULL` de max_items.
-- Efecto: un pedido con muchas unidades que cumple monto y reputacion ahora se aprueba solo. Historico: 0 de 22
-- pedidos cambian de resultado (maximo 5 unidades). Restaurantes sin parametros siguen en revision manual.
-- Sin cambios de GRANT (CREATE OR REPLACE conserva los existentes).
-- ORDEN: aplicar ANTES de desplegar el restaurant-dashboard que deja de guardar max_items. La limpieza de las
-- claves guardadas y del DEFAULT va en 038, DESPUES de ese deploy.

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

    -- Los dos criterios son concurrentes.
    IF (NEW.status IN ('PENDIENTE', 'CREADA'))
       AND NEW.total_amount <= v_max_amount
       AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;
