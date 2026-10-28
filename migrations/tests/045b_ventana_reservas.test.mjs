// Pruebas de 045b_ventana_reservas.sql sobre PGlite (Postgres en WASM, un solo proceso).
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node migrations/tests/045b_ventana_reservas.test.mjs
// No prueba concurrencia real ni los grants automáticos de Supabase: tras aplicar hay que verificar proacl / role_table_grants en la base real.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(dir, '..', '045b_ventana_reservas.sql'), 'utf8');
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const R_CRI = 'c8f518ae-2da9-4bb4-a95f-cca4c6b96056'; // 15 min, forma canónica de 045a
const R_30 = '11111111-1111-1111-1111-111111111111';  // 30 min, ventana propia
const R_NIGHT = '22222222-2222-2222-2222-222222222222'; // turno que cruza la medianoche
const U1 = '99999999-9999-9999-9999-999999999999';

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table restaurants (id uuid primary key, name text, opening_hours jsonb default '{}', slot_interval_minutes int not null default 30,
    slot_duration int default 90, space_capacities jsonb, capacity int, is_active boolean default true);
  create table reservation_blocks (restaurant_id uuid, is_active boolean, start_time timestamptz, end_time timestamptz, blocked_slots int);
  create table reservations (id uuid primary key default gen_random_uuid(), restaurant_id uuid, organizer_id uuid, date_time timestamptz, status text,
    payment_method text, title text, guest_ids uuid[], guest_data jsonb, guests jsonb, party_size int, organizer_reputation_snapshot numeric,
    user_total_reservations_snapshot int, discount_data_snapshot jsonb, applied_discount_id uuid, account_type_snapshot text, benefits_snapshot jsonb,
    validated_by_user boolean, validated_by_restaurant boolean, special_requests text, unique_code text, timestamps jsonb, created_by_staff boolean default false,
    metadata jsonb);
  grant insert on reservations to authenticated, anon;
  -- stubs de lo que la migración usa y ya existe en producción
  create function restaurant_plan_allows(uuid) returns boolean language sql as $$ select true $$;
  create function restaurant_effective_state(uuid) returns text language sql as $$ select 'vigente' $$;
  create function operation_limit_check(uuid) returns jsonb language sql as $$ select null::jsonb $$;
  create function inventory_caller_role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', nullif(current_setting('request.jwt.claim.role', true), '')) $$;
`);
const std = (o, c) => ({ monday: [{ open: o, close: c }], tuesday: [{ open: o, close: c }], wednesday: [{ open: o, close: c }], thursday: [{ open: o, close: c }], friday: [{ open: o, close: c }], saturday: [{ is_closed: true }], sunday: [{ is_closed: true }] });
const cri = { monday: [{ open: '12:00', close: '21:00' }], tuesday: [{ open: '12:00', close: '16:00' }], wednesday: [{ open: '12:00', close: '23:00' }], thursday: [{ open: '10:00', close: '16:00' }], friday: [{ open: '12:00', close: '16:00' }], saturday: [{ is_closed: true }], sunday: [{ is_closed: true }] };
const night = { ...std('12:00', '13:00'), friday: [{ open: '20:00', close: '02:00' }], saturday: [{ open: '20:00', close: '02:00' }] };
await db.query(`insert into restaurants (id, name, opening_hours, slot_interval_minutes) values ($1,'Cri-Olla',$2,15), ($3,'R30',$4,30), ($5,'Noche',$6,30)`,
  [R_CRI, JSON.stringify(cri), R_30, JSON.stringify(std('12:00', '16:00')), R_NIGHT, JSON.stringify(night)]);

await db.exec(migration);
await db.exec(migration); // idempotente: segunda ejecución no falla
ok('migración re-ejecutable', true);

// instante local de Santiago -> timestamptz
const at = (local) => `('${local}'::timestamp AT TIME ZONE 'America/Santiago')`;
const rule = async (id, local) => (await one(`select reservation_slot_rule($1, ${at(local)}) as v`, [id])).v;
const allowed = async (id, local) => (await one(`select reservation_slot_allowed($1, ${at(local)}) as v`, [id])).v;
const setOn = (on) => db.exec(`update reservation_window_enforcement set enabled = ${on}`);

// ---- interruptor apagado: no cambia nada ----
ok('interruptor nace apagado', (await one(`select enabled from reservation_window_enforcement`)).enabled === false);
ok('apagado: permite cualquier hora (sábado 03:07)', await allowed(R_CRI, '2026-10-31 03:07:00') === true);
ok('apagado: la regla pura sigue diciendo que no', await rule(R_CRI, '2026-10-31 03:07:00') === false);

// ---- regla con atención (reservation_hours NULL), Cri-Olla 15 min. 2026-10-26 es lunes ----
await setOn(true);
const cases = [
  ['lun 12:00 abre', '2026-10-26 12:00:00', true], ['lun 12:15', '2026-10-26 12:15:00', true], ['lun 20:45 último inicio', '2026-10-26 20:45:00', true],
  ['lun 21:00 cierre (excluido)', '2026-10-26 21:00:00', false], ['lun 11:45 antes de abrir', '2026-10-26 11:45:00', false],
  ['lun 12:07 fuera de grilla', '2026-10-26 12:07:00', false], ['lun 12:00:30 con segundos', '2026-10-26 12:00:30', false],
  ['mié 22:45 (cierra 23)', '2026-10-28 22:45:00', true], ['mié 23:00', '2026-10-28 23:00:00', false],
  ['sáb cerrado', '2026-10-31 13:00:00', false], ['dom cerrado', '2026-11-01 13:00:00', false],
];
for (const [n, t, e] of cases) ok(`atención: ${n}`, await allowed(R_CRI, t) === e);
ok('intervalo 30: 12:15 no, 12:30 sí', (await allowed(R_30, '2026-10-26 12:15:00')) === false && (await allowed(R_30, '2026-10-26 12:30:00')) === true);
ok('restaurante inexistente: allowed true, rule null', (await allowed('00000000-0000-0000-0000-000000000000', '2026-10-26 12:00:00')) === true && (await rule('00000000-0000-0000-0000-000000000000', '2026-10-26 12:00:00')) === null);

// ---- ventana propia ----
const setWin = (id, w) => db.query(`update restaurants set reservation_hours = $2 where id = $1`, [id, w === null ? null : JSON.stringify(w)]);
await setWin(R_30, { monday: [{ open: '12:00', close: '14:30' }, { open: '15:00', close: '16:00' }], tuesday: [{ is_closed: true }] });
ok('ventana: 14:00 sí', await allowed(R_30, '2026-10-26 14:00:00') === true);
ok('ventana: 14:30 no (cierre excluido)', await allowed(R_30, '2026-10-26 14:30:00') === false);
ok('ventana: hueco 14:45 no', await allowed(R_30, '2026-10-26 14:45:00') === false);
ok('ventana: segundo turno 15:30 sí', await allowed(R_30, '2026-10-26 15:30:00') === true);
ok('ventana: martes cerrado explícito (la atención está abierta)', await allowed(R_30, '2026-10-27 13:00:00') === false);
ok('ventana: miércoles ausente = sin reservas (no hereda)', await allowed(R_30, '2026-10-28 13:00:00') === false);
await setWin(R_30, { monday: [{ open: '12:10', close: '14:00' }] });
ok('grilla desde la apertura de la ventana: 12:10, 12:40 sí', (await allowed(R_30, '2026-10-26 12:10:00')) === true && (await allowed(R_30, '2026-10-26 12:40:00')) === true);
ok('grilla desde la apertura de la ventana: 12:30 no', await allowed(R_30, '2026-10-26 12:30:00') === false);
await setWin(R_30, null);
ok('ventana NULL vuelve a heredar la atención', await allowed(R_30, '2026-10-27 13:00:00') === true);

// ---- coherencia (trigger) ----
const bad = async (w) => fails(() => setWin(R_30, w));
ok('rechaza ventana fuera de la atención', (await bad({ monday: [{ open: '11:00', close: '13:00' }] }))?.message.includes('fuera del horario'));
ok('rechaza ventana en día cerrado de atención', (await bad({ saturday: [{ open: '12:00', close: '13:00' }] }))?.message.includes('fuera del horario'));
ok('rechaza día desconocido', (await bad({ lun: [{ open: '12:00', close: '13:00' }] }))?.message.includes('día no válido'));
ok('rechaza clave corta', (await bad({ mon: [{ open: '12:00', close: '13:00' }] }))?.message.includes('día no válido'));
ok('rechaza más de 4 turnos', (await bad({ monday: [1, 2, 3, 4, 5].map(() => ({ open: '12:00', close: '13:00' })) }))?.message.includes('hasta 4'));
ok('rechaza hora mal formada', (await bad({ monday: [{ open: '12:0', close: '13:00' }] }))?.message.includes('formato'));
ok('rechaza open = close', (await bad({ monday: [{ open: '13:00', close: '13:00' }] }))?.message.includes('formato'));
ok('rechaza claves extra en el turno', (await bad({ monday: [{ open: '12:00', close: '13:00', x: 1 }] }))?.message.includes('formato'));
ok('rechaza cerrado con otros turnos', (await bad({ monday: [{ is_closed: true }, { open: '12:00', close: '13:00' }] }))?.message.includes('cerrado'));
ok('rechaza valor no objeto', (await bad([1]))?.message.includes('objeto'));
ok('acepta ventana válida', (await fails(() => setWin(R_30, { monday: [{ open: '12:00', close: '16:00' }] }))) === null);
ok('cambiar opening_hours NO se bloquea (la ventana se recorta sola)', (await fails(() => db.query(`update restaurants set opening_hours = $2 where id = $1`, [R_30, JSON.stringify(std('13:00', '14:00'))]))) === null);
ok('…y la ventana efectiva queda recortada: 12:00 ya no, 13:00 sí', (await allowed(R_30, '2026-10-26 12:00:00')) === false && (await allowed(R_30, '2026-10-26 13:00:00')) === true);
await setWin(R_30, null);
await db.query(`update restaurants set opening_hours = $2 where id = $1`, [R_30, JSON.stringify(std('12:00', '16:00'))]);

// ---- cruce de medianoche ----
ok('noche: vie 20:00 sí, vie 23:30 sí', (await allowed(R_NIGHT, '2026-10-30 20:00:00')) === true && (await allowed(R_NIGHT, '2026-10-30 23:30:00')) === true);
ok('noche: sáb 01:30 (turno del viernes) sí', await allowed(R_NIGHT, '2026-10-31 01:30:00') === true);
ok('noche: sáb 02:00 no (cierre)', await allowed(R_NIGHT, '2026-10-31 02:00:00') === false);
ok('noche: dom 01:30 (turno del sábado) sí', await allowed(R_NIGHT, '2026-11-01 01:30:00') === true);
ok('noche: lun 01:30 no (el domingo no abre)', await allowed(R_NIGHT, '2026-11-02 01:30:00') === false);
await setWin(R_NIGHT, { friday: [{ open: '22:00', close: '01:00' }] });
ok('noche con ventana 22:00-01:00: vie 21:30 no, 22:00 sí, sáb 00:30 sí, sáb 01:00 no', (await allowed(R_NIGHT, '2026-10-30 21:30:00')) === false && (await allowed(R_NIGHT, '2026-10-30 22:00:00')) === true && (await allowed(R_NIGHT, '2026-10-31 00:30:00')) === true && (await allowed(R_NIGHT, '2026-10-31 01:00:00')) === false);
await setWin(R_NIGHT, null);

// ---- cambio de hora: nunca lanza error y siempre devuelve boolean ----
let dstOk = true;
for (const base of ['2026-09-05 22:00:00', '2026-04-03 22:00:00']) {
  const rows = await q(`select reservation_slot_rule($1, g) as v from generate_series(${at(base)}, ${at(base)} + interval '8 hours', interval '30 minutes') g`, [R_NIGHT]);
  dstOk = dstOk && rows.every((r) => typeof r.v === 'boolean');
}
ok('noches de cambio de hora: siempre boolean, sin error', dstOk);

// ---- create_reservation_atomic ----
const rpc = async (id, local, extra = {}) => (await one(`select create_reservation_atomic($1, $2, ${at(local)}, 2, $3::jsonb) as r`, [id, U1, JSON.stringify({ unique_code: 'C' + Math.random().toString(36).slice(2, 8), ...extra })])).r;
await setOn(false);
ok('RPC apagado: acepta fuera de ventana', (await rpc(R_CRI, '2026-10-31 03:07:00')).success === true);
await setOn(true);
const out = await rpc(R_CRI, '2026-10-31 03:07:00');
ok('RPC encendido: rechaza con code outside_reservation_window', out.success === false && out.code === 'outside_reservation_window');
ok('RPC rechazado no inserta', (await one(`select count(*)::int n from reservations where restaurant_id = $1 and date_time = ${at('2026-10-31 03:07:00')}`, [R_CRI])).n === 1 /* solo la del caso apagado */);
ok('RPC encendido: acepta dentro de ventana', (await rpc(R_CRI, '2026-10-26 13:00:00')).success === true);
ok('RPC: la reserva del personal tampoco entra fuera de ventana (D5)', (await rpc(R_CRI, '2026-10-31 13:00:00', { created_by_staff: true })).code === 'outside_reservation_window');
ok('RPC: restaurante inexistente sigue respondiendo "no encontrado"', (await rpc('00000000-0000-0000-0000-000000000000', '2026-10-26 13:00:00')).error === 'Restaurante no encontrado');

// ---- INSERT directo de un cliente ----
const direct = async (role, local) => {
  await db.exec(`set role ${role}; select set_config('request.jwt.claims', '{"role":"${role}"}', false);`);
  try {
    return await fails(() => db.query(`insert into reservations (restaurant_id, organizer_id, date_time, status, party_size) values ($1,$2,${at(local)},'PENDIENTE',2)`, [R_CRI, U1]));
  } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`); }
};
const e1 = await direct('authenticated', '2026-10-31 13:00:00');
ok('INSERT directo authenticated fuera de ventana: rechazado con HINT', e1 && /no recibe reservas/.test(e1.message), e1?.message);
ok('INSERT directo authenticated dentro de ventana: pasa', (await direct('authenticated', '2026-10-26 14:00:00')) === null);
const e2 = await direct('anon', '2026-10-31 13:00:00');
ok('INSERT directo anon fuera de ventana: rechazado', e2 && /no recibe reservas/.test(e2.message), e2?.message);
await setOn(false);
ok('INSERT directo con el interruptor apagado: pasa', (await direct('authenticated', '2026-10-31 13:00:00')) === null);
await setOn(true);
ok('INSERT como dueño/service_role (sin claims de cliente) no se toca', (await fails(() => db.query(`insert into reservations (restaurant_id, organizer_id, date_time, status, party_size) values ($1,$2,${at('2026-10-31 13:00:00')},'PENDIENTE',2)`, [R_CRI, U1]))) === null);

// ---- permisos ----
const fp = async (role, sig) => (await one(`select has_function_privilege('${role}', '${sig}', 'EXECUTE') as v`)).v;
for (const sig of ['_hours_day_shifts(jsonb,integer)', 'reservation_slot_rule(uuid,timestamptz)', 'reservation_slot_allowed(uuid,timestamptz)', 'create_reservation_atomic(uuid,uuid,timestamptz,integer,jsonb)', 'reservations_window_guard()', 'restaurants_reservation_hours_guard()']) {
  ok(`EXECUTE ${sig}: service_role sí; anon/authenticated/public no`, (await fp('service_role', sig)) && !(await fp('anon', sig)) && !(await fp('authenticated', sig)));
}
const tp = async (role, priv) => (await one(`select has_table_privilege('${role}', 'reservation_window_enforcement', '${priv}') as v`)).v;
ok('interruptor: service_role SELECT/UPDATE; sin INSERT/DELETE; anon/authenticated nada', (await tp('service_role', 'SELECT')) && (await tp('service_role', 'UPDATE')) && !(await tp('service_role', 'INSERT')) && !(await tp('service_role', 'DELETE')) && !(await tp('anon', 'SELECT')) && !(await tp('authenticated', 'SELECT')));
ok('interruptor: RLS activa', (await one(`select relrowsecurity v from pg_class where relname='reservation_window_enforcement'`)).v === true);

console.log(`\n${pass} pasan, ${fail} fallan`);
process.exit(fail ? 1 : 0);
