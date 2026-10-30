-- Prueba de 050_guest_addition_declined_notice.sql (requiere la 049 y la 050 aplicadas). Se revierte SIEMPRE: termina con RAISE EXCEPTION 'DRYRUN: ...'.
-- Resultado esperado (verificado el 2026-10-30 contra la base real con la migración dentro del mismo DO):
--   1) needs=true status=PENDIENTE size=3 | 2) status=CONFIRMADA size=1, declined con removed_guests [Ana, Beto] | 3) claim1=1 claim2=0
--   4) claim_tras_marcar=0 attempts=1 notified=t
DO $t$
DECLARE rid uuid := gen_random_uuid(); rest uuid; org uuid; res jsonb; s1 record; s2 record; out text := ''; n1 int; n2 int; n3 int;
BEGIN
  SELECT id INTO rest FROM restaurants ORDER BY created_at LIMIT 1;
  SELECT id INTO org FROM profiles WHERE reservation_reputation IS NOT NULL AND takeaway_reputation IS NOT NULL LIMIT 1;
  UPDATE restaurants SET reservation_settings = jsonb_set(coalesce(reservation_settings,'{}'::jsonb), '{max_party_size}', '2') WHERE id = rest;
  INSERT INTO reservations (id, restaurant_id, organizer_id, date_time, status, party_size, unique_code, payment_method, guest_data, guests, metadata)
  VALUES (rid, rest, org, now() + interval '2 days', 'PENDIENTE', 1, 'ZZDRY002', 'individual',
          jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name','Org','is_organizer',true,'status','CONFIRMADA')), '[]'::jsonb, '{}'::jsonb);
  UPDATE reservations SET status = 'CONFIRMADA' WHERE id = rid;
  res := add_reservation_guests(rid, org, jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name','Ana Prueba'), jsonb_build_object('id', gen_random_uuid(), 'name','Beto Prueba')));
  SELECT status, party_size INTO s1 FROM reservations WHERE id = rid;
  out := out || format('1) needs=%s status=%s size=%s; ', res->>'needs_approval', s1.status, s1.party_size);
  UPDATE reservations SET status = 'RECHAZADA', rejected_at = now() WHERE id = rid;
  SELECT status, party_size, metadata->'guest_addition_declined' AS d INTO s2 FROM reservations WHERE id = rid;
  out := out || format('2) status=%s size=%s declined=%s; ', s2.status, s2.party_size, s2.d);
  SELECT count(*) INTO n1 FROM claim_guest_addition_declines(20, rid);
  SELECT count(*) INTO n2 FROM claim_guest_addition_declines(20, rid);
  out := out || format('3) claim1=%s claim2=%s; ', n1, n2);
  PERFORM mark_guest_addition_decline_notified(rid);
  UPDATE reservations SET metadata = jsonb_set(metadata, '{guest_addition_declined,notify_claimed_at}', to_jsonb(now() - interval '10 minutes')) WHERE id = rid;
  SELECT count(*) INTO n3 FROM claim_guest_addition_declines(20, rid);
  SELECT metadata #>> '{guest_addition_declined,attempts}' AS att, metadata #>> '{guest_addition_declined,notified_at}' IS NOT NULL AS notified INTO s1 FROM reservations WHERE id = rid;
  out := out || format('4) claim_tras_marcar=%s attempts=%s notified=%s; ', n3, s1.att, s1.notified);
  RAISE EXCEPTION 'DRYRUN: %', out;
END $t$;
