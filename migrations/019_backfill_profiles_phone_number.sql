-- 019_backfill_profiles_phone_number.sql
-- El onboarding guardaba el teléfono solo en profiles.phone, pero takeaway, checkout y la
-- búsqueda de invitados leen profiles.phone_number primero. Copia phone -> phone_number donde
-- falte (verificado 2026-09-30: 4 filas, 0 conflictos). Idempotente.
UPDATE public.profiles
SET phone_number = phone
WHERE phone IS NOT NULL AND phone <> ''
  AND (phone_number IS NULL OR phone_number = '');
