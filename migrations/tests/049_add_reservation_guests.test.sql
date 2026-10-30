-- Prueba de 049_add_reservation_guests.sql. Se ejecuta DESPUÉS de aplicar la migración (o dentro de un DO con EXECUTE de ella)
-- y SIEMPRE se revierte: termina con RAISE EXCEPTION 'DRYRUN: ...' con el resultado. Resultado esperado (verificado el 2026-10-30
-- contra la base real, con la migración dentro del mismo DO):
--   1) success, status=CONFIRMADA size=2 gd=2 | 2) not_organizer | 3) duplicate_guest
--   4) needs=true status=PENDIENTE size=3 pend=t | 5) status=CONFIRMADA size=2 gd=2 pend=f rejected_at=(vacío) | 6) no_capacity
DO $t$
DECLARE rid uuid := gen_random_uuid(); rest uuid; org uuid; res jsonb; res2 jsonb; s1 record; s2 record; out text := ''; gid1 uuid := gen_random_uuid(); gid2 uuid := gen_random_uuid();
BEGIN
  SELECT id INTO rest FROM restaurants ORDER BY created_at LIMIT 1;
  SELECT id INTO org FROM profiles WHERE reservation_reputation IS NOT NULL AND takeaway_reputation IS NOT NULL LIMIT 1;
  UPDATE restaurants SET reservation_settings = jsonb_set(coalesce(reservation_settings,'{}'::jsonb), '{max_party_size}', '10') WHERE id = rest;
  INSERT INTO reservations (id, restaurant_id, organizer_id, date_time, status, party_size, unique_code, payment_method, guest_data, guests, metadata)
  VALUES (rid, rest, org, now() + interval '2 days', 'PENDIENTE', 1, 'ZZDRY001', 'individual',
          jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name','Org','is_organizer',true,'status','CONFIRMADA')), '[]'::jsonb, '{}'::jsonb);
  UPDATE reservations SET status = 'CONFIRMADA' WHERE id = rid;
  res := add_reservation_guests(rid, org, jsonb_build_array(jsonb_build_object('id', gid1, 'name','Ana Prueba','email','a@x.cl')));
  SELECT status, party_size, jsonb_array_length(guest_data) gd INTO s1 FROM reservations WHERE id = rid;
  out := out || format('1) %s | status=%s size=%s gd=%s; ', res, s1.status, s1.party_size, s1.gd);
  out := out || format('2) %s; ', add_reservation_guests(rid, gen_random_uuid(), jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name','X')))->>'code');
  out := out || format('3) %s; ', add_reservation_guests(rid, org, jsonb_build_array(jsonb_build_object('id', gid1, 'name','Ana Prueba')))->>'code');
  UPDATE restaurants SET reservation_settings = jsonb_set(reservation_settings, '{max_party_size}', '2') WHERE id = rest;
  res2 := add_reservation_guests(rid, org, jsonb_build_array(jsonb_build_object('id', gid2, 'name','Beto Prueba')));
  SELECT status, party_size, metadata ? 'guest_addition_pending' AS pend INTO s2 FROM reservations WHERE id = rid;
  out := out || format('4) needs=%s status=%s size=%s pend=%s; ', res2->>'needs_approval', s2.status, s2.party_size, s2.pend);
  UPDATE reservations SET status = 'RECHAZADA', rejected_at = now(), cancellation_reason = 'x' WHERE id = rid;
  SELECT status, party_size, jsonb_array_length(guest_data) gd, metadata ? 'guest_addition_pending' AS pend, rejected_at INTO s2 FROM reservations WHERE id = rid;
  out := out || format('5) status=%s size=%s gd=%s pend=%s rejected_at=%s; ', s2.status, s2.party_size, s2.gd, s2.pend, s2.rejected_at);
  UPDATE restaurants SET capacity = 1, space_capacities = NULL WHERE id = rest;
  out := out || format('6) %s; ', add_reservation_guests(rid, org, jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name','Zeta')))->>'code');
  RAISE EXCEPTION 'DRYRUN: %', out;
END $t$;
