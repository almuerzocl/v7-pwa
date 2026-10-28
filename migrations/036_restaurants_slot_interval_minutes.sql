-- Intervalo entre horarios de reserva configurable por restaurante (antes fijo en 30 min en el código).
-- Valores permitidos: 10, 15, 30 y 60 minutos. Por defecto 30 => aplicar esta migración no cambia nada para nadie.
-- Lo leen reservation-slots.ts (PWA y restaurant-dashboard, archivo idéntico) para la grilla de horarios y para validar
-- que la hora pedida sea un horario ofrecido. create_reservation_atomic NO impone la grilla (la valida la aplicación).
-- Columna nueva en tabla existente: no requiere GRANT nuevo (los de `restaurants` ya cubren la fila completa).
-- ORDEN: aplicar ANTES de desplegar PWA y dashboard (su consulta de horarios selecciona esta columna y fallaría sin ella).
ALTER TABLE public.restaurants
    ADD COLUMN IF NOT EXISTS slot_interval_minutes integer NOT NULL DEFAULT 30;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_slot_interval_minutes_check') THEN
        ALTER TABLE public.restaurants
            ADD CONSTRAINT restaurants_slot_interval_minutes_check CHECK (slot_interval_minutes IN (10, 15, 30, 60));
    END IF;
END $$;
