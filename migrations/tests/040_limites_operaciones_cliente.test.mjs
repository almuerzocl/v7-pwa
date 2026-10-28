// Pruebas de 040_limites_operaciones_cliente.sql sobre PGlite (Postgres en WASM, un solo proceso).
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node 040_limites_operaciones_cliente.test.mjs
// NO prueba concurrencia real (PGlite es de una sola conexión): se verifica que el lock por usuario se tome y se mantenga hasta
// el fin de la transacción; la carrera real de dos conexiones se razona, no se ejecuta aquí.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(dir, '..', '040_limites_operaciones_cliente.sql'), 'utf8');
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const UE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const R1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const asRole = async (role, sub, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ role, sub: sub ?? null })}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims','',false);`); }
};
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const detail = (e) => { try { return JSON.parse(e.detail); } catch { return null; } };

// ---------- esquema stub que replica producción (solo lo que toca la migración) ----------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table profiles (id uuid primary key, account_type text not null default 'free');
  create table restaurants (id uuid primary key, slot_duration int, space_capacities jsonb, capacity int);
  create table reservation_blocks (restaurant_id uuid, is_active boolean, blocked_slots int, start_time timestamptz, end_time timestamptz);
  create table reservations (
    id uuid primary key default gen_random_uuid(), restaurant_id uuid, organizer_id uuid, user_id uuid, date_time timestamptz,
    status text not null default 'PENDIENTE', payment_method text, title text, guest_ids uuid[], guest_data jsonb, guests jsonb,
    party_size int, organizer_reputation_snapshot numeric, user_total_reservations_snapshot int, discount_data_snapshot jsonb,
    applied_discount_id uuid, account_type_snapshot text, benefits_snapshot jsonb, validated_by_user boolean, validated_by_restaurant boolean,
    special_requests text, unique_code text, timestamps jsonb, metadata jsonb, created_at timestamptz not null default now());
  create table takeaway_orders (
    id uuid primary key default gen_random_uuid(), user_id uuid, restaurant_id uuid, items jsonb, total_amount int,
    status text not null default 'PENDIENTE', timestamps jsonb, metadata jsonb, created_at timestamptz not null default now());
  grant all on all tables in schema public to authenticated, anon, service_role;
  create function inventory_caller_role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', nullif(current_setting('request.jwt.claim.role', true), '')) $$;
  create function restaurant_plan_allows(r uuid) returns boolean language sql stable as $$ select coalesce(current_setting('test.plan_blocked', true), '') <> 'on' $$;
  create function restaurant_effective_state(r uuid) returns text language sql stable as $$ select 'activo' $$;
  insert into profiles values ('${U1}','free'), ('${U2}','free'), ('${UE}','elite');
  insert into restaurants values ('${R1}', 90, '{}'::jsonb, 100);
`);
await db.exec(migration);

const resetData = async () => {
  await db.exec(`delete from reservations; delete from takeaway_orders; update operation_limits set enabled=true, daily_limit=2, weekly_limit=10; set test.plan_blocked = 'off';`);
};
// Inserta como postgres (sin claims = confianza) con created_at explícito.
const seedRes = (uid, at, extra = {}) => q(
  `insert into reservations(restaurant_id, organizer_id, date_time, party_size, created_at, status, timestamps, created_by_staff)
   values ($1,$2, now() + interval '30 days', 2, $3, $4, $5, $6)`,
  [R1, uid, at, extra.status ?? 'PENDIENTE', extra.timestamps ? JSON.stringify(extra.timestamps) : null, extra.staff ?? false]);
const seedOrd = (uid, at, extra = {}) => q(
  `insert into takeaway_orders(user_id, restaurant_id, items, total_amount, created_at, status, timestamps, created_by_staff)
   values ($1,$2,'[]'::jsonb,1000,$3,$4,$5,$6)`,
  [uid, R1, at, extra.status ?? 'PENDIENTE', extra.timestamps ? JSON.stringify(extra.timestamps) : null, extra.staff ?? false]);
const check = async (uid, now) => (await q(`select operation_limit_check($1, $2::timestamptz) r`, [uid, now]))[0].r;
const orderAs = (role, uid, extraCols = '', extraVals = '') =>
  asRole(role, uid, () => q(`insert into takeaway_orders(user_id, restaurant_id, items, total_amount${extraCols}) values ('${uid}','${R1}','[]'::jsonb,1000${extraVals}) returning *`));
const resAs = (role, uid) =>
  asRole(role, uid, () => q(`insert into reservations(restaurant_id, organizer_id, date_time, party_size) values ('${R1}','${uid}', now() + interval '30 days', 2) returning *`));
const rpc = (uid, data = {}) => asRole('service_role', null, () =>
  q(`select create_reservation_atomic($1,$2, now() + interval '40 days', 2, $3::jsonb) r`, [R1, uid, JSON.stringify({ unique_code: 'C' + Math.random().toString(36).slice(2, 8), ...data })]));

// Viernes 2026-10-23 12:00 hora de Santiago (UTC-3).
const FRI = '2026-10-23T12:00:00-03:00';

// ---------- 1. Interruptor ----------
await resetData();
await db.exec(`update operation_limits set enabled=false`);
for (let i = 0; i < 4; i++) await orderAs('authenticated', U1);
ok('interruptor apagado: 4 pedidos seguidos pasan', (await q(`select count(*)::int c from takeaway_orders`))[0].c === 4);
ok('interruptor apagado: operation_usage dice limited=false', (await q(`select operation_usage($1) u`, [U1]))[0].u.limited === false);

// ---------- 2. Diario: la 2 pasa, la 3 falla (pedidos y reservas), con código estable ----------
await resetData();
await orderAs('authenticated', U1);
await resAs('authenticated', U1);
ok('2 operaciones de hoy (1 pedido + 1 reserva) pasan', (await q(`select count(*)::int c from takeaway_orders`))[0].c === 1 && (await q(`select count(*)::int c from reservations`))[0].c === 1);
const e3 = await fails(() => orderAs('authenticated', U1));
ok('3ª (pedido) falla con HINT limit_reached', e3 && e3.hint === 'limit_reached', String(e3?.message));
ok('detalle: límite diario, usado 2, libera mañana 00:00 Santiago', detail(e3)?.limit === 'daily' && detail(e3)?.used === 2 && detail(e3)?.limit_value === 2);
const e3b = await fails(() => resAs('authenticated', U1));
ok('3ª (reserva directa) también falla: reserva y pedido suman juntos', e3b && e3b.hint === 'limit_reached');
ok('otro usuario no se ve afectado', (await orderAs('authenticated', U2)).length === 1);

// ---------- 3. Semanal: la 10 pasa, la 11 falla ----------
await resetData();
for (const d of ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']) { // lunes a jueves, 2 por día = 8
  await seedOrd(U1, `${d}T10:00:00-03:00`); await seedRes(U1, `${d}T11:00:00-03:00`);
}
await seedOrd(U1, '2026-10-23T09:00:00-03:00'); // viernes: 9ª
ok('9 en la semana, 1 hoy: la 10ª pasa', (await check(U1, FRI)) === null);
await seedRes(U1, '2026-10-23T10:00:00-03:00'); // 10ª
const wk = await check(U1, FRI);
ok('con 10 en la semana la 11ª falla (weekly)', wk?.limit === 'weekly' && wk?.used === 10 && wk?.limit_value === 10, JSON.stringify(wk));
ok('weekly libera el lunes 00:00 Santiago', new Date(wk.resets_at).toISOString() === '2026-10-26T03:00:00.000Z', wk?.resets_at);

// ---------- 4. Bordes de medianoche de Santiago ----------
await resetData();
await seedOrd(U1, '2026-10-24T23:30:00-03:00'); await seedRes(U1, '2026-10-24T23:40:00-03:00'); // sábado
ok('sábado 23:50: tope diario', (await check(U1, '2026-10-24T23:50:00-03:00'))?.limit === 'daily');
ok('domingo 00:10 (cambio de día en Santiago): el cupo diario se libera', (await check(U1, '2026-10-25T00:10:00-03:00')) === null);
await resetData();
for (let i = 0; i < 5; i++) { await seedOrd(U1, `2026-10-2${i}T10:00:00-03:00`); await seedRes(U1, `2026-10-2${i}T10:30:00-03:00`); }
// 10 ops de lun 20 a vie 24? i=0..4 -> 20..24 (lun-vie), 2 por día
ok('domingo 25 23:50: tope semanal con 10', (await check(U1, '2026-10-25T23:50:00-03:00'))?.limit === 'weekly');
ok('lunes 26 00:10 (cambio de semana): el cupo semanal se libera', (await check(U1, '2026-10-26T00:10:00-03:00')) === null);
// operación a las 22:30 UTC-3 = 01:30Z del día siguiente: cuenta en el día de Santiago, no en el UTC
await resetData();
await seedOrd(U1, '2026-10-22T22:30:00-03:00'); await seedRes(U1, '2026-10-22T22:40:00-03:00'); // jueves noche (ya viernes en UTC)
ok('hora de Santiago, no UTC: jueves 22:30 cuenta para el jueves', (await check(U1, '2026-10-22T23:00:00-03:00'))?.limit === 'daily' && (await check(U1, FRI)) === null);

// ---------- 5. Elite exento ----------
await resetData();
for (let i = 0; i < 5; i++) await orderAs('authenticated', UE);
ok('Elite: 5 pedidos el mismo día pasan', (await q(`select count(*)::int c from takeaway_orders where user_id=$1`, [UE]))[0].c === 5);
const ue = (await q(`select operation_usage($1) u`, [UE]))[0].u;
ok('Elite: operation_usage elite=true, limited=false', ue.elite === true && ue.limited === false);

// ---------- 6. Operaciones del personal no cuentan ----------
await resetData();
await orderAs('authenticated', U1); await resAs('authenticated', U1);
ok('tope alcanzado antes del personal', (await fails(() => orderAs('authenticated', U1))) !== null);
await orderAs('service_role', U1, ', created_by_staff', ', true');
ok('pedido manual del personal (service_role) pasa aun con el cliente en el tope', (await q(`select count(*)::int c from takeaway_orders where user_id=$1`, [U1]))[0].c === 2);
const rs = (await rpc(U1, { created_by_staff: true }))[0].r;
ok('reserva manual del personal vía RPC pasa en el tope y queda marcada', rs.success === true && (await q(`select created_by_staff s from reservations where id=$1`, [rs.id]))[0].s === true, JSON.stringify(rs));
ok('lo del personal no suma al contador', (await q(`select operation_usage($1) u`, [U1]))[0].u.daily_used === 2);
const rb = (await rpc(U1))[0].r;
ok('RPC sin marca de personal en el tope: code limit_reached', rb.success === false && rb.code === 'limit_reached' && rb.limit === 'daily', JSON.stringify(rb));

// ---------- 7. El cliente no puede burlar la marca ni la fecha ----------
await resetData();
const sneaky = (await orderAs('authenticated', U1, ', created_by_staff, created_at', `, true, now() - interval '5 days'`))[0];
ok('INSERT de cliente con created_by_staff=true: se fuerza a false', sneaky.created_by_staff === false);
ok('INSERT de cliente con created_at pasado: se fuerza a now()', Math.abs(new Date(sneaky.created_at) - Date.now()) < 60000);
await orderAs('authenticated', U1);
ok('esas dos cuentan: la 3ª falla', (await fails(() => orderAs('authenticated', U1)))?.hint === 'limit_reached');
await asRole('authenticated', U1, () => q(`update takeaway_orders set created_by_staff=true, created_at=now() - interval '9 days' where id=$1`, [sneaky.id]));
const after = (await q(`select created_by_staff s, created_at from takeaway_orders where id=$1`, [sneaky.id]))[0];
ok('UPDATE de cliente no cambia created_by_staff ni created_at', after.s === false && Math.abs(new Date(after.created_at) - Date.now()) < 60000);
await asRole('service_role', null, () => q(`update takeaway_orders set created_by_staff=true where id=$1`, [sneaky.id]));
ok('service_role sí puede marcarla', (await q(`select created_by_staff s from takeaway_orders where id=$1`, [sneaky.id]))[0].s === true);

// ---------- 8. Qué estados cuentan ----------
await resetData();
await seedOrd(U1, FRI, { status: 'CANCELADO', timestamps: { CANCELADO: { actor_role: 'customer' } } });
await seedRes(U1, FRI, { status: 'CANCELADA', timestamps: { CANCELADA: { actor_role: 'user' } } });
ok('canceladas por el propio cliente SÍ cuentan', (await check(U1, FRI))?.limit === 'daily');
await resetData();
await seedRes(U1, FRI, { status: 'CANCELADA', timestamps: { CANCELADA: { actor_role: 'system' } } });
await seedRes(U1, FRI, { status: 'CANCELADA', timestamps: { CANCELADA: { actor_role: 'admin' } } });
await seedOrd(U1, FRI, { status: 'RECHAZADA' });
await seedRes(U1, FRI, { status: 'RECHAZADA' });
ok('canceladas por sistema/restaurante y RECHAZADA no cuentan', (await q(`select (operation_counts($1,$2::timestamptz)).daily_used d`, [U1, FRI]))[0].d === 0);
await resetData();
await seedRes(U1, FRI, { status: 'CANCELADA' });
await seedOrd(U1, FRI, { status: 'NO_RETIRADO' });
ok('cancelada sin actor (desconocido) y NO_RETIRADO sí cuentan (falla cerrada)', (await check(U1, FRI))?.limit === 'daily');
// el cliente no puede reescribir el actor para que no cuente
await resetData();
const o = (await orderAs('authenticated', U1))[0];
const forged = await fails(() => asRole('authenticated', U1, () =>
  q(`update takeaway_orders set status='CANCELADO', timestamps='{"CANCELADO":{"actor_role":"system"}}' where id=$1`, [o.id])));
ok('cliente que escribe actor_role=system en timestamps: rechazado', forged && forged.hint === 'forbidden_actor', String(forged?.message));
const legit = await fails(() => asRole('authenticated', U1, () =>
  q(`update takeaway_orders set status='CANCELADO', timestamps='{"CANCELADO":{"actor_role":"customer"}}' where id=$1`, [o.id])));
ok('cliente que cancela con actor customer: permitido', legit === null);
const forgedIns = await fails(() => asRole('authenticated', U1, () =>
  q(`insert into takeaway_orders(user_id, restaurant_id, items, total_amount, timestamps) values ($1,$2,'[]'::jsonb,1,'{"CANCELADO":{"actor_role":"admin"}}')`, [U1, R1])));
ok('INSERT de cliente con actor de personal en timestamps: rechazado', forgedIns && forgedIns.hint === 'forbidden_actor');

// ---------- 9. plan_blocked tiene prioridad en la RPC; el lock por usuario se toma ----------
await resetData();
await db.exec(`set test.plan_blocked = 'on'`);
const pb = (await rpc(U1))[0].r;
ok('RPC con local bloqueado: plan_blocked (antes que el límite)', pb.code === 'plan_blocked');
await resetData();
await db.exec('begin');
await q(`select operation_limit_check($1)`, [U1]);
const locks = await q(`select count(*)::int c from pg_locks where locktype='advisory' and pid = pg_backend_pid()`);
ok('operation_limit_check toma un advisory lock que vive en la transacción', locks[0].c >= 1);
await db.exec('commit');

// ---------- 10. Permisos ----------
const priv = await q(`select grantee, privilege_type from information_schema.role_table_grants where table_name='operation_limits' and grantee in ('anon','authenticated','service_role') order by 1,2`);
ok('operation_limits: service_role solo SELECT/UPDATE', priv.map((p) => `${p.grantee}:${p.privilege_type}`).join() === 'service_role:SELECT,service_role:UPDATE', JSON.stringify(priv));
const fnPriv = await q(`select has_function_privilege('authenticated','public.operation_usage(uuid,timestamptz)','EXECUTE') a, has_function_privilege('anon','public.operation_limit_check(uuid,timestamptz)','EXECUTE') b, has_function_privilege('service_role','public.operation_usage(uuid,timestamptz)','EXECUTE') c`);
ok('operation_usage/limit_check: sin EXECUTE para anon/authenticated, sí service_role', fnPriv[0].a === false && fnPriv[0].b === false && fnPriv[0].c === true);
const cfgRead = await fails(() => asRole('authenticated', U1, () => q(`select * from operation_limits`)));
ok('authenticated no lee operation_limits', cfgRead !== null);

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
