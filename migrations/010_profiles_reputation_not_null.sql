-- 010: la reputacion (takeaway y reservas) nunca puede ser NULL.
--
-- Estado real en produccion (kqanordhsmbtcwtjtrme, verificado 2026-09-30):
--   * CHECK 0..100 YA existe: profiles_takeaway_reputation_check y profiles_reservation_reputation_check.
--     (Un CHECK deja pasar NULL, por eso no bastaba.)
--   * Ambas columnas eran NULLABLE con DEFAULT 100. Los 32 perfiles tienen valores validos (0..100),
--     ninguno NULL -> SET NOT NULL es seguro, sin backfill.
-- El DEFAULT 100 se mantiene: un perfil nuevo sin valor explicito nace con reputacion 100.
-- Un UPDATE/INSERT que intente NULL falla con 23502; fuera de 0..100 falla con 23514 (CHECK existente).

ALTER TABLE public.profiles ALTER COLUMN takeaway_reputation SET NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN reservation_reputation SET NOT NULL;
