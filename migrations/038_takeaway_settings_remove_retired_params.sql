-- 038: limpieza de los parametros de pedidos retirados (decision del usuario, 2026-10-06).
--  * `max_items` (unidades por pedido): lo dejo de leer el trigger en 037.
--  * `kitchen_units_per_slot` (capacidad de cocina por tramo): se elimino la franja "Retiros por tramo" del panel.
-- Quita las claves de takeaway_settings (6 restaurantes tenian max_items = 15; ninguno kitchen_units_per_slot) y
-- del DEFAULT de la columna. No es una tabla nueva: no requiere GRANT.
-- ORDEN: aplicar DESPUES de 037 y de desplegar el restaurant-dashboard sin esos parametros. Si se aplica antes,
-- el panel viejo veria "Aun no guardas los criterios" porque exigia max_items.

UPDATE public.restaurants
   SET takeaway_settings = takeaway_settings - 'max_items' - 'kitchen_units_per_slot'
 WHERE takeaway_settings ?| ARRAY['max_items', 'kitchen_units_per_slot'];

ALTER TABLE public.restaurants
    ALTER COLUMN takeaway_settings SET DEFAULT '{"min_reputation": 80, "max_order_amount": 150000}'::jsonb;
