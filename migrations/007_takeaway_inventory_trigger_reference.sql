-- 007: REFERENCIA de la funcion/trigger de inventario que YA existe en produccion.
-- Capturado de kqanordhsmbtcwtjtrme el 2026-09-29 (pg_get_functiondef / pg_get_triggerdef).
-- Solo versiona lo existente (venia de V5_ARCHITECTURE_FINAL.sql, ya no en git).
-- Es idempotente y equivale a lo desplegado; no cambia comportamiento.
--
-- IMPORTANTE: este trigger descuenta stock al pasar a APROBADA (incluido INSERT ya
-- APROBADA via tr_auto_approve_takeaway_order) y lo devuelve en RECHAZADA/CANCELADO/ANULADO.
-- La app NO debe volver a descontar stock: seria doble descuento.

CREATE OR REPLACE FUNCTION public.handle_takeaway_inventory()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_item jsonb;
    v_menu_item_id uuid;
    v_quantity integer;
BEGIN
    -- DEDUCT STOCK ON APPROVAL
    IF (TG_OP = 'INSERT' AND NEW.status = 'APROBADA') OR
       (TG_OP = 'UPDATE' AND OLD.status != 'APROBADA' AND NEW.status = 'APROBADA') THEN
        IF NEW.items IS NOT NULL AND jsonb_typeof(NEW.items) = 'array' THEN
            FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
                v_menu_item_id := COALESCE((v_item->>'id')::uuid, (v_item->>'menu_item_id')::uuid);
                v_quantity := COALESCE((v_item->>'quantity')::integer, 1);
                IF v_menu_item_id IS NOT NULL THEN
                    UPDATE public.menu_items
                    SET current_stock = GREATEST(0, current_stock - v_quantity),
                        is_available = CASE WHEN (current_stock - v_quantity) <= 0 THEN false ELSE is_available END
                    WHERE id = v_menu_item_id AND stock_managed = true;
                END IF;
            END LOOP;
        END IF;
    END IF;

    -- RETURN STOCK ON REJECTION/CANCELLATION
    IF TG_OP = 'UPDATE' AND OLD.status = 'APROBADA' AND
       (NEW.status IN ('RECHAZADA', 'CANCELADO', 'ANULADO')) THEN
        IF NEW.items IS NOT NULL AND jsonb_typeof(NEW.items) = 'array' THEN
            FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
                v_menu_item_id := COALESCE((v_item->>'id')::uuid, (v_item->>'menu_item_id')::uuid);
                v_quantity := COALESCE((v_item->>'quantity')::integer, 1);
                IF v_menu_item_id IS NOT NULL THEN
                    UPDATE public.menu_items
                    SET current_stock = current_stock + v_quantity,
                        updated_at = now()
                    WHERE id = v_menu_item_id AND stock_managed = true;
                END IF;
            END LOOP;
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tr_handle_takeaway_inventory ON public.takeaway_orders;
CREATE TRIGGER tr_handle_takeaway_inventory
    AFTER INSERT OR UPDATE ON public.takeaway_orders
    FOR EACH ROW EXECUTE FUNCTION public.handle_takeaway_inventory();
