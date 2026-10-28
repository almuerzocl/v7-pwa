-- 009: auto_approve_takeaway_order() debe usar la reputacion de TAKEAWAY, no la de reservas.
--
-- Bug: la funcion calculaba v_user_reputation con COALESCE(reservation_reputation, 100).
-- La reputacion aplica por ambito: takeaway -> takeaway_reputation; reservas -> reservation_reputation.
--
-- Regla de negocio (confirmada por el usuario, 2026-09-30):
--   * La reputacion es un atributo de usuarios reales y activos, entre 0 y 100.
--   * Un pedido sin user_id no puede crearse.
--   * Un usuario con reputacion NULL (en CUALQUIER ambito) no puede ejecutar ninguna operacion.
--   * No hay valor por defecto: se elimina el COALESCE(..., 100). NULL se rechaza.
--
-- Base: definicion real de produccion (kqanordhsmbtcwtjtrme) leida con pg_get_functiondef el
-- 2026-09-30. La logica de aprobacion (estado, monto maximo, reputacion minima) no cambia.
-- Sin cambios de permisos/GRANT: CREATE OR REPLACE conserva los existentes.
-- Las validaciones del usuario van ANTES del early-return por falta de takeaway_settings,
-- para que se apliquen en todos los restaurantes.

CREATE OR REPLACE FUNCTION public.auto_approve_takeaway_order()
 RETURNS trigger
 LANGUAGE plpgsql
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

    v_max_amount := COALESCE((v_settings->>'max_order_amount')::numeric, 150000);
    v_min_reputation := COALESCE((v_settings->>'min_reputation')::integer, 80);

    IF (NEW.status IN ('PENDIENTE', 'CREADA')) AND NEW.total_amount <= v_max_amount AND v_takeaway_reputation >= v_min_reputation THEN
        NEW.status := 'APROBADA';
        NEW.approved_at := now();
    END IF;
    RETURN NEW;
END;
$function$;
