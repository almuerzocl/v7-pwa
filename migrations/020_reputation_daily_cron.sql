-- 020: reputacion diaria unica -- funcion en BD (la dispara el job de Cloud Scheduler).
--
-- Regla de negocio (confirmada por el usuario el 2026-10-02), la MISMA para reservas y pedidos:
--   reputacion = ROUND(100 * cumplidas / (cumplidas + incumplidas))   (100 si no hay operaciones resueltas)
-- sobre los ultimos 30 dias calendario en America/Santiago, SIN contar hoy: la ventana es
-- [hoy-30d, hoy) con "hoy" = 00:00 hora de Chile. El valor es el mismo durante las 24 h (idempotente).
--
--   Reservas  (fecha = date_time, usuario = organizer_id)
--     cumplida   : COMPLETADA, CHECK-IN CLIENTE
--     incumplida : NO_SHOW   (incluye la cancelacion del cliente con <= 1 h de anticipacion:
--                  cancel-reservation-action.ts la guarda como NO_SHOW)
--   Pedidos   (fecha = created_at, usuario = user_id)
--     cumplida   : ENTREGADO, COMPLETADO
--     incumplida : NO_RETIRADO (incluye la cancelacion del cliente una vez en PREPARANDO/LISTO:
--                  cancel-takeaway-action.ts la guarda como NO_RETIRADO)
--   Fuera del calculo: CANCELADA/CANCELADO (cliente antes del limite, o restaurante), RECHAZADA y
--   todo estado en curso. Quien cancela queda en timestamps->'<ESTADO>'->>'actor_role'.
--
-- Base: definicion real de la funcion leida con pg_get_functiondef en produccion el 2026-10-02
-- (antes: -15 pts por NO_SHOW/NO_RETIRADO, ventana NOW()-60d, ejecutada por nadie).
-- Otras dos formulas quedan obsoletas (checkout-engine.ts: -20 pts combinado; api/tasks/
-- calculate-reputation: proporcion a 60 dias): ver PR.
--
-- Garantias: reservation_reputation y takeaway_reputation siempre en 0..100 (CHECKs de profiles);
-- idempotente (UPDATE solo si el valor cambia); sin tablas nuevas -> sin GRANT de tabla nuevos.
-- EXECUTE solo para service_role (decision 2026-09-30): el REVOKE/GRANT se repite aqui a proposito.
--
-- Programacion: NO se usa pg_cron. El job vive en Cloud Scheduler junto a los demas (decision del
-- usuario, 2026-10-02): `pwa-calculate-reputation`, 03:30 America/Santiago (zona horaria nativa, sin
-- desfase de horario de verano), que llama a GET /api/tasks/calculate-reputation de la PWA; esa ruta solo
-- ejecuta esta funcion con service_role. Corre 30 min DESPUES de `pwa-close-day` (03:00), que marca
-- NO_SHOW / NO_RETIRADO del dia anterior. (El job ya existia y ejecutaba la formula vieja desde la PWA.)

CREATE OR REPLACE FUNCTION public.calculate_daily_reputation()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_hasta timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago';
    v_desde timestamptz := (date_trunc('day', now() AT TIME ZONE 'America/Santiago') - interval '30 days') AT TIME ZONE 'America/Santiago';
BEGIN
    WITH res AS (
        SELECT organizer_id AS id,
               count(*) FILTER (WHERE status IN ('COMPLETADA', 'CHECK-IN CLIENTE')) AS ok,
               count(*) FILTER (WHERE status = 'NO_SHOW') AS bad
        FROM public.reservations
        WHERE organizer_id IS NOT NULL
          AND date_time >= v_desde AND date_time < v_hasta
        GROUP BY organizer_id
    ),
    ord AS (
        SELECT user_id AS id,
               count(*) FILTER (WHERE status IN ('ENTREGADO', 'COMPLETADO')) AS ok,
               count(*) FILTER (WHERE status = 'NO_RETIRADO') AS bad
        FROM public.takeaway_orders
        WHERE user_id IS NOT NULL
          AND created_at >= v_desde AND created_at < v_hasta
        GROUP BY user_id
    ),
    nuevo AS (
        SELECT p.id,
               COALESCE(ROUND(100.0 * res.ok / NULLIF(res.ok + res.bad, 0)), 100)::int AS reservation_reputation,
               COALESCE(ROUND(100.0 * ord.ok / NULLIF(ord.ok + ord.bad, 0)), 100)::int AS takeaway_reputation
        FROM public.profiles p
        LEFT JOIN res ON res.id = p.id
        LEFT JOIN ord ON ord.id = p.id
    )
    UPDATE public.profiles p
       SET reservation_reputation = nuevo.reservation_reputation,
           takeaway_reputation    = nuevo.takeaway_reputation
      FROM nuevo
     WHERE nuevo.id = p.id
       AND (p.reservation_reputation IS DISTINCT FROM nuevo.reservation_reputation
         OR p.takeaway_reputation    IS DISTINCT FROM nuevo.takeaway_reputation);
END;
$function$;

REVOKE ALL ON FUNCTION public.calculate_daily_reputation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_daily_reputation() TO service_role;
