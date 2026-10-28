-- Agrega columnas lat/lng a restaurants extraídas desde la columna PostGIS location.
-- Estas columnas se mantienen en sync con location vía trigger.

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS lat  float8,
  ADD COLUMN IF NOT EXISTS lng  float8;

-- Poblar desde datos existentes
UPDATE public.restaurants
  SET lat = ST_Y(location::geometry),
      lng = ST_X(location::geometry)
  WHERE location IS NOT NULL;

-- Trigger para mantener lat/lng sincronizados al actualizar location
CREATE OR REPLACE FUNCTION public.sync_restaurant_lat_lng()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location IS NOT NULL THEN
    NEW.lat := ST_Y(NEW.location::geometry);
    NEW.lng := ST_X(NEW.location::geometry);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_restaurant_lat_lng ON public.restaurants;
CREATE TRIGGER trg_sync_restaurant_lat_lng
  BEFORE INSERT OR UPDATE OF location ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION public.sync_restaurant_lat_lng();
