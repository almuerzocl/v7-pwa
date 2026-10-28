-- 021: reservations -- un cliente no puede cambiar el estado ni los datos criticos de su reserva por
-- UPDATE directo. Contraparte de takeaway_orders_client_guard (008).
--
-- Brecha verificada en produccion (2026-10-02): la policy "Users can update own reservations"
-- (UPDATE, public, auth.uid() = organizer_id) y el GRANT de UPDATE a anon/authenticated dejan al
-- organizador escribir CUALQUIER columna. Un cliente podia pasar su reserva a CANCELADA directamente
-- (saltandose cancel-reservation-action, que penaliza como NO_SHOW la cancelacion con < 1 h),
-- o mover date_time a futuro antes de cancelar para evitar la penalizacion.
--
-- Flujos legitimos de la PWA por UPDATE directo (revisados en codigo, 2026-10-02):
--   * check-in: status CONFIRMADA -> 'CHECK-IN CLIENTE' + timestamps  (reservations/page.tsx y [id]/page.tsx)
--   * backfill de guests[].user_id (no toca status)                    (reservations/page.tsx)
-- Cancelar, confirmar, completar, NO_SHOW, etc. pasan por server actions / transition_status con
-- service_role, que este guard NO restringe (solo actua con JWT anon/authenticated).
--
-- Reglas (solo para JWT anon, o authenticated que no sea SUPER_ADMIN):
--   1. restaurant_id, organizer_id, user_id, date_time y party_size no se pueden modificar.      (RSV01)
--   2. status solo puede cambiar de CONFIRMADA a 'CHECK-IN CLIENTE'.                             (RSV02)
-- Sin tablas nuevas -> sin GRANT de tabla nuevos. La funcion de trigger no se expone: EXECUTE solo
-- para el owner y service_role (decision 2026-09-30 / migracion 018).

CREATE OR REPLACE FUNCTION public.reservations_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    -- is_super_admin() no tiene EXECUTE para anon: solo se consulta con rol authenticated.
    IF public.inventory_caller_role() = 'anon'
       OR (public.inventory_caller_role() = 'authenticated' AND NOT public.is_super_admin()) THEN
        IF NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
        OR NEW.organizer_id  IS DISTINCT FROM OLD.organizer_id
        OR NEW.user_id       IS DISTINCT FROM OLD.user_id
        OR NEW.date_time     IS DISTINCT FROM OLD.date_time
        OR NEW.party_size    IS DISTINCT FROM OLD.party_size THEN
            RAISE EXCEPTION 'El cliente no puede modificar restaurante, organizador, fecha ni tamano de la reserva'
                USING ERRCODE = 'RSV01';
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
               OLD.status = 'CONFIRMADA' AND NEW.status = 'CHECK-IN CLIENTE'
        ) THEN
            RAISE EXCEPTION 'Transicion no permitida para el cliente: % -> %', OLD.status, NEW.status
                USING ERRCODE = 'RSV02';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.reservations_client_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reservations_client_guard() TO service_role;

DROP TRIGGER IF EXISTS tr_reservations_client_guard ON public.reservations;
CREATE TRIGGER tr_reservations_client_guard
    BEFORE UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION public.reservations_client_guard();
