// Pruebas de 041_elite_comensales.sql sobre PGlite (Postgres en WASM). Carga ANTES la migración 040 (de la que 041 redefine funciones).
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node 041_elite_comensales.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const m040 = readFileSync(join(dir, '..', '040_limites_operaciones_cliente.sql'), 'utf8');
const m041 = readFileSync(join(dir, '..', '041_elite_comensales.sql'), 'utf8');
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const R1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const asRole = async (role, sub, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ role, sub: sub ?? null })}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims','',false);`); }
};
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------- esquema stub que replica producción (solo lo que tocan 040 y 041) ----------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table profiles (id uuid primary key, email text, account_type text not null default 'free' check (account_type in ('free','elite')),
    reservation_reputation int not null default 100, takeaway_reputation int not null default 100);
  create table restaurants (id uuid primary key, name text, slot_duration int, space_capacities jsonb, capacity int,
    reservation_settings jsonb, takeaway_settings jsonb);
  create table reservation_blocks (restaurant_id uuid, is_active boolean, blocked_slots int, start_time timestamptz, end_time timestamptz);
  create table reservations (
    id uuid primary key default gen_random_uuid(), restaurant_id uuid, organizer_id uuid, user_id uuid, date_time timestamptz,
    status text not null default 'PENDIENTE', payment_method text, title text, guest_ids uuid[], guest_data jsonb, guests jsonb,
    party_size int, organizer_reputation_snapshot numeric, user_total_reservations_snapshot int, discount_data_snapshot jsonb,
    applied_discount_id uuid, account_type_snapshot text, benefits_snapshot jsonb, validated_by_user boolean, validated_by_restaurant boolean,
    special_requests text, unique_code text, timestamps jsonb, metadata jsonb, approved_at timestamptz, confirmed_at timestamptz,
    created_at timestamptz not null default now());
  create table takeaway_orders (
    id uuid primary key default gen_random_uuid(), user_id uuid, restaurant_id uuid, items jsonb, total_amount int,
    status text not null default 'PENDIENTE', timestamps jsonb, metadata jsonb, approved_at timestamptz, created_at timestamptz not null default now());
  create table notifications (id uuid primary key default gen_random_uuid(), user_id uuid, restaurant_id uuid, type text, title text, message text,
    related_id uuid, priority text, actor_id uuid, actor_role text);
  grant all on all tables in schema public to authenticated, anon, service_role;
  create function inventory_caller_role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', nullif(current_setting('request.jwt.claim.role', true), '')) $$;
  create function restaurant_plan_allows(r uuid) returns boolean language sql stable as $$ select true $$;
  create function restaurant_effective_state(r uuid) returns text language sql stable as $$ select 'activo' $$;
  insert into profiles(id, email, reservation_reputation, takeaway_reputation) values
    ('${U1}', 'Ana@Correo.cl', 40, 40), ('${U2}', 'otra@correo.cl', 100, 100);
  insert into restaurants values ('${R1}', 'Local', 90, '{}'::jsonb, 100,
    '{"max_party_size": 10, "min_reputation": 80}'::jsonb, '{"max_order_amount": 50000, "min_reputation": 80}'::jsonb);
`);
await db.exec(m040);
await db.exec(m041);
// Los triggers de autoaprobación existen en producción; aquí se crean sobre las funciones que deja la 041.
await db.exec(`
  create trigger tr_auto_approve_reservation before insert on reservations for each row execute function auto_approve_reservation();
  create trigger tr_auto_approve_takeaway before insert on takeaway_orders for each row execute function auto_approve_takeaway_order();
`);

const addPeriod = (uid, startOffset, endOffset, status, order = null, line = 0, unit = 0) => q(
  `insert into elite_periods(user_id, order_id, line_index, unit_index, starts_at, ends_at, status)
   values ($1, $2, $3, $4, now() + $5::interval, now() + $6::interval, $7) returning id`,
  [uid, order, order === null ? null : line, unit, startOffset, endOffset, status]);
const reset = async () => {
  await db.exec(`delete from elite_periods; delete from reservations; delete from takeaway_orders; update profiles set account_type='free';
                 update operation_limits set enabled=true, daily_limit=2, weekly_limit=10;`);
};
const acct = async (uid) => (await q(`select account_type a from profiles where id=$1`, [uid]))[0].a;

// ---------- 1. is_elite decide por fechas, con 3 días de gracia ----------
await reset();
ok('sin períodos: no es ELITE', (await q(`select is_elite($1) r`, [U1]))[0].r === false);
await addPeriod(U1, '-10 days', '20 days', 'vigente', 1);
ok('período corriendo: ELITE', (await q(`select is_elite($1) r`, [U1]))[0].r === true);
const at = (offset) => q(`select is_elite($1, now() + $2::interval) r`, [U1, offset]).then((r) => r[0].r);
ok('justo antes del fin: ELITE', await at('19 days 23 hours'));
ok('2 días después del fin (gracia): ELITE', await at('22 days'));
ok('3 días después del fin: ya no (la gracia es de 3 días exactos)', (await at('23 days')) === false);
ok('antes de empezar el período: no', (await at('-11 days')) === false);
await reset();
await addPeriod(U1, '1 day', '31 days', 'en_cola', 2);
ok('período en cola con inicio futuro: aún no es ELITE', (await q(`select is_elite($1) r`, [U1]))[0].r === false);
await reset();
await addPeriod(U1, '-10 days', '20 days', 'anulado', 3);
ok('período anulado (reembolso): no es ELITE', (await q(`select is_elite($1) r`, [U1]))[0].r === false);
await reset();
await addPeriod(U1, '-40 days', '-10 days', 'vencido', 4);
ok('período vencido hace 10 días: no es ELITE (gracia ya pasó)', (await q(`select is_elite($1) r`, [U1]))[0].r === false);
await addPeriod(U1, '-10 days', '20 days', 'vigente', 5);
ok('renovación pagada tarde (anterior vencido hace 10 d, nuevo vigente): ELITE', (await q(`select is_elite($1) r`, [U1]))[0].r === true);

// ---------- 2. Reputación efectiva ----------
await reset();
const rep = async (uid, scope) => (await q(`select effective_reputation($1,$2) r`, [uid, scope]))[0].r;
ok('FREE: reputación real (40) en ambos ámbitos', (await rep(U1, 'reservation')) === 40 && (await rep(U1, 'takeaway')) === 40);
await addPeriod(U1, '-1 day', '29 days', 'vigente', 10);
ok('ELITE: 100 en ambos ámbitos', (await rep(U1, 'reservation')) === 100 && (await rep(U1, 'takeaway')) === 100);
ok('la reputación REAL del perfil no se toca', (await q(`select reservation_reputation r, takeaway_reputation t from profiles where id=$1`, [U1]))[0].r === 40);
ok('usuario inexistente: NULL (falla cerrada en el trigger)', (await rep('99999999-9999-9999-9999-999999999999', 'takeaway')) === null);
ok('ámbito inválido: error', (await fails(() => q(`select effective_reputation($1,'otro')`, [U1]))) !== null);
await db.exec(`update elite_periods set status='anulado'`);
ok('al anularse el período vuelve la reputación real', (await rep(U1, 'reservation')) === 40);

// ---------- 3. Caché account_type ----------
await reset();
ok('sin períodos: free', (await acct(U1)) === 'free');
const p1 = (await addPeriod(U1, '-1 day', '29 days', 'vigente', 20))[0].id;
ok('trigger: al insertar un período vigente la cuenta pasa a elite', (await acct(U1)) === 'elite');
await db.exec(`update elite_periods set status='anulado' where id='${p1}'`);
ok('trigger: al anular vuelve a free', (await acct(U1)) === 'free');
await reset();
await addPeriod(U1, '-40 days', '-5 days', 'vencido', 21);
await db.exec(`update profiles set account_type='elite' where id='${U1}'`); // caché desactualizada: venció por fecha sin tocar filas
const synced = (await q(`select elite_sync_all() n`))[0].n;
ok('elite_sync_all baja una cuenta vencida (hace 5 días > 3 de gracia)', (await acct(U1)) === 'free' && synced === 1, String(synced));
await reset();
await addPeriod(U1, '-1 day', '29 days', 'vigente', 22);
await db.exec(`update profiles set account_type='free' where id='${U1}'`); // alguien la bajó a mano
await q(`select elite_sync_all()`);
ok('elite_sync_all sube una cuenta con período activo', (await acct(U1)) === 'elite');
ok('elite_sync_all no toca a quien no tiene períodos', (await acct(U2)) === 'free');
await reset();
await addPeriod(U1, '-5 days', '25 days', 'vigente', 23);
await db.exec(`update profiles set account_type='free' where id='${U1}'`);
ok('elite_sync_all idempotente: segunda corrida sin cambios', (await q(`select elite_sync_all() n`))[0].n === 1 && (await q(`select elite_sync_all() n`))[0].n === 0);

// ---------- 4. Cruce por correo ----------
const byEmail = async (e) => (await q(`select elite_profile_by_email($1) r`, [e]))[0].r;
ok('correo exacto', (await byEmail('otra@correo.cl')) === U2);
ok('ignora mayúsculas y espacios', (await byEmail('  ANA@correo.CL ')) === U1);
ok('correo distinto: NULL', (await byEmail('ana+x@correo.cl')) === null);
ok('NULL y vacío: NULL', (await byEmail(null)) === null && (await byEmail('  ')) === null);
await db.exec(`insert into profiles(id, email) values ('33333333-3333-3333-3333-333333333333', 'OTRA@correo.cl')`);
ok('correo con dos cuentas (ambiguo): NULL, no adivina', (await byEmail('otra@correo.cl')) === null);
await db.exec(`delete from profiles where id='33333333-3333-3333-3333-333333333333'`);

// ---------- 5. Idempotencia e integridad de períodos ----------
await reset();
await addPeriod(U1, '-1 day', '29 days', 'vigente', 30, 0, 0);
const dup = await fails(() => addPeriod(U1, '29 days', '59 days', 'en_cola', 30, 0, 0));
ok('misma unidad (pedido:línea:unidad) dos veces: rechazada', dup && /duplicate|unique/i.test(dup.message), String(dup?.message));
ok('otra unidad del mismo pedido: permitida', (await addPeriod(U1, '29 days', '59 days', 'en_cola', 30, 0, 1)).length === 1);
const two = await fails(() => addPeriod(U1, '-2 days', '28 days', 'vigente', 31, 0, 0));
ok('dos períodos vigentes de la misma cuenta: rechazado', two && /duplicate|unique/i.test(two.message));
ok('cortesías sin pedido (order_id nulo) repetidas: permitidas', (await addPeriod(U2, '1 day', '31 days', 'en_cola')).length === 1 && (await addPeriod(U2, '31 days', '61 days', 'en_cola')).length === 1);
ok('un período no puede terminar antes de empezar', (await fails(() => addPeriod(U2, '5 days', '2 days', 'en_cola', 32))) !== null);

// ---------- 6. Límites de operaciones (040) con ELITE ----------
await reset();
const ord = (uid) => asRole('authenticated', uid, () => q(`insert into takeaway_orders(user_id, restaurant_id, items, total_amount) values ('${uid}','${R1}','[]'::jsonb, 100000) returning id`));
await ord(U1); await ord(U1);
ok('FREE: la 3ª operación del día falla', (await fails(() => ord(U1)))?.hint === 'limit_reached');
await addPeriod(U1, '-1 day', '29 days', 'vigente', 40);
await ord(U1); await ord(U1);
ok('ELITE: sigue sin tope (4ª y 5ª pasan)', (await q(`select count(*)::int c from takeaway_orders where user_id=$1`, [U1]))[0].c === 4);
const us = (await q(`select operation_usage($1) u`, [U1]))[0].u;
ok('operation_usage: elite=true, limited=false', us.elite === true && us.limited === false);
await db.exec(`update elite_periods set status='anulado'`);
ok('al terminar ELITE vuelve el tope', (await fails(() => ord(U1)))?.hint === 'limit_reached');
ok('operation_usage: elite=false, limited=true', (await q(`select operation_usage($1) u`, [U1]))[0].u.limited === true);

// ---------- 7. Autoaprobación con reputación efectiva ----------
await reset();
const resv = (uid, party = 2) => q(`insert into reservations(restaurant_id, organizer_id, date_time, party_size) values ($1,$2, now() + interval '30 days', $3) returning status, timestamps`, [R1, uid, party]);
const ordIns = (uid, amount = 10000) => q(`insert into takeaway_orders(user_id, restaurant_id, items, total_amount) values ($1,$2,'[]'::jsonb,$3) returning status`, [uid, R1, amount]);
await db.exec(`update operation_limits set enabled=false`);
ok('FREE con reputación 40 (mínimo 80): reserva queda PENDIENTE', (await resv(U1))[0].status === 'PENDIENTE');
ok('FREE con reputación 40: pedido queda PENDIENTE', (await ordIns(U1))[0].status === 'PENDIENTE');
await addPeriod(U1, '-1 day', '29 days', 'vigente', 50);
const re = (await resv(U1))[0];
ok('ELITE: la reserva se autoaprueba (reputación 100 >= 80)', re.status === 'CONFIRMADA' && /reputacion 100 >= 80/.test(re.timestamps.CONFIRMADA.reason), JSON.stringify(re));
ok('ELITE: el pedido se autoaprueba', (await ordIns(U1))[0].status === 'APROBADA');
ok('ELITE no salta los otros criterios: grupo de 11 > máximo 10 queda PENDIENTE', (await resv(U1, 11))[0].status === 'PENDIENTE');
ok('ELITE no salta el monto máximo: pedido de 60.000 > 50.000 queda PENDIENTE', (await ordIns(U1, 60000))[0].status === 'PENDIENTE');
ok('la reputación real sigue en 40 tras aprobar', (await q(`select reservation_reputation r from profiles where id=$1`, [U1]))[0].r === 40);
await db.exec(`update elite_periods set status='anulado'`);
ok('ELITE anulado: vuelve a PENDIENTE', (await resv(U1))[0].status === 'PENDIENTE' && (await ordIns(U1))[0].status === 'PENDIENTE');

// ---------- 8. Permisos ----------
const fnPriv = await q(`select
  has_function_privilege('authenticated','public.is_elite(uuid,timestamptz)','EXECUTE') a,
  has_function_privilege('anon','public.effective_reputation(uuid,text)','EXECUTE') b,
  has_function_privilege('authenticated','public.elite_profile_by_email(text)','EXECUTE') c,
  has_function_privilege('authenticated','public.elite_sync_all()','EXECUTE') d,
  has_function_privilege('service_role','public.is_elite(uuid,timestamptz)','EXECUTE') e,
  has_function_privilege('service_role','public.elite_sync_all()','EXECUTE') f`);
const f = fnPriv[0];
ok('anon/authenticated no ejecutan ninguna función ELITE; service_role sí', !f.a && !f.b && !f.c && !f.d && f.e && f.f, JSON.stringify(f));
const tg = await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants where table_name in ('elite_periods','elite_notices') and grantee in ('anon','authenticated','service_role') order by 1,2,3`);
ok('tablas ELITE: solo service_role con SELECT/INSERT/UPDATE (sin DELETE)',
  tg.map((t) => `${t.table_name}:${t.grantee}:${t.privilege_type}`).join() ===
  'elite_notices:service_role:INSERT,elite_notices:service_role:SELECT,elite_notices:service_role:UPDATE,elite_periods:service_role:INSERT,elite_periods:service_role:SELECT,elite_periods:service_role:UPDATE', JSON.stringify(tg));
ok('authenticated no lee elite_periods', (await fails(() => asRole('authenticated', U1, () => q(`select * from elite_periods`)))) !== null);
ok('un cliente no puede hacerse ELITE insertando un período', (await fails(() => asRole('authenticated', U1, () => q(`insert into elite_periods(user_id, starts_at, ends_at) values ($1, now(), now() + interval '30 days')`, [U1])))) !== null);

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
