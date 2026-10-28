-- 045a: opening_hours de los locales a la forma canónica (solo datos, sin cambio de esquema).
-- Forma canónica: claves largas monday..sunday; cada día es un arreglo de turnos [{open,close}] o [{is_closed:true}].
-- Regla: el resultado de getOpeningShiftsForDay (restaurant-hours.ts) por día NO cambia. No toca operating_hours.
-- Solo cambian Cri-Olla (claves cortas y largas a la vez) y Zanzíbar (objetos por día, clave corta y larga); los otros 5
-- ya están en forma canónica o vacíos y se dejan como están.
-- Idempotente y seguro ante cambios concurrentes: cada UPDATE exige que el valor actual sea EXACTAMENTE el leído el
-- 2026-10-26; si ya es el canónico no hace nada, y si es otro valor lo omite con un WARNING (no pisa ediciones nuevas).

DO $$
DECLARE
  r record;
  v_n int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- Cri-Olla: lector prefiere la clave corta; sábado sin clave = cerrado; domingo is_closed:true = cerrado
      ('c8f518ae-2da9-4bb4-a95f-cca4c6b96056'::uuid, 'Cri-Olla',
       '{"fri":{"open":"12:00","close":"16:00","is_closed":false},"mon":{"open":"12:00","close":"21:00","is_closed":false},"sun":{"open":"09:00","close":"22:00","is_closed":true},"thu":{"open":"10:00","close":"16:00","is_closed":false},"tue":{"open":"12:00","close":"16:00","is_closed":false},"wed":{"open":"12:00","close":"23:00","is_closed":false},"friday":{"open":"12:00","close":"16:00","is_closed":false},"monday":{"open":"12:00","close":"21:00","is_closed":false},"sunday":{"open":"09:00","close":"22:00","is_closed":true},"tuesday":{"open":"12:00","close":"16:00","is_closed":false},"thursday":{"open":"10:00","close":"16:00","is_closed":false},"wednesday":{"open":"12:00","close":"23:00","is_closed":false}}'::jsonb,
       '{"monday":[{"open":"12:00","close":"21:00"}],"tuesday":[{"open":"12:00","close":"16:00"}],"wednesday":[{"open":"12:00","close":"23:00"}],"thursday":[{"open":"10:00","close":"16:00"}],"friday":[{"open":"12:00","close":"16:00"}],"saturday":[{"is_closed":true}],"sunday":[{"is_closed":true}]}'::jsonb),
      -- Zanzíbar: lun-sáb 09-22, domingo cerrado
      ('2729b647-33c8-4419-8967-f668ec3ce61d'::uuid, 'Zanzíbar',
       '{"fri":{"open":"09:00","close":"22:00","is_closed":false},"mon":{"open":"09:00","close":"22:00","is_closed":false},"sat":{"open":"09:00","close":"22:00","is_closed":false},"thu":{"open":"09:00","close":"22:00","is_closed":false},"tue":{"open":"09:00","close":"22:00","is_closed":false},"wed":{"open":"09:00","close":"22:00","is_closed":false},"friday":{"open":"09:00","close":"22:00","is_closed":false},"monday":{"open":"09:00","close":"22:00","is_closed":false},"sunday":[{"is_closed":true}],"tuesday":{"open":"09:00","close":"22:00","is_closed":false},"saturday":{"open":"09:00","close":"22:00","is_closed":false},"thursday":{"open":"09:00","close":"22:00","is_closed":false},"wednesday":{"open":"09:00","close":"22:00","is_closed":false}}'::jsonb,
       '{"monday":[{"open":"09:00","close":"22:00"}],"tuesday":[{"open":"09:00","close":"22:00"}],"wednesday":[{"open":"09:00","close":"22:00"}],"thursday":[{"open":"09:00","close":"22:00"}],"friday":[{"open":"09:00","close":"22:00"}],"saturday":[{"open":"09:00","close":"22:00"}],"sunday":[{"is_closed":true}]}'::jsonb)
    ) AS t(id, nombre, old_v, new_v)
  LOOP
    UPDATE public.restaurants SET opening_hours = r.new_v
     WHERE id = r.id AND opening_hours = r.old_v;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      IF EXISTS (SELECT 1 FROM public.restaurants WHERE id = r.id AND opening_hours = r.new_v) THEN
        RAISE NOTICE '045a: % ya está en forma canónica', r.nombre;
      ELSE
        RAISE WARNING '045a: % omitido (opening_hours distinto al esperado o local inexistente)', r.nombre;
      END IF;
    END IF;
  END LOOP;
END $$;
