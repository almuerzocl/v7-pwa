// Paridad TS <-> SQL de la ventana de reservas: la intersección ventana ∩ atención de `getReservationShiftsForDay`
// (restaurant-hours.ts) debe dar exactamente los mismos horarios de inicio que `reservation_slot_rule` (migración 045b).
// Se compara cada instante de 5 min de una semana sin cambio de hora (2026-10-26 a 2026-11-01) para varias configuraciones.
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node migrations/tests/045b_paridad_ts.test.mjs
// (Node >= 22.18 importa el .ts directamente. MIGRATION=<ruta> para apuntar a otro archivo 045b.)
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const migPath = process.env.MIGRATION ?? [join(dir, '..', '045b_ventana_reservas.sql'), '/Users/estebanzarate/wt-hours-045b/migrations/045b_ventana_reservas.sql'].find(existsSync);
const migration = readFileSync(migPath, 'utf8');
const { getReservationShiftsForDay } = await import(join(dir, '..', '..', 'src', 'lib', 'core-business', 'restaurant-hours.ts'));
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

const t = (o, c) => [{ open: o, close: c }];
const X = [{ is_closed: true }];
const week = (f) => Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, f(d)]));
const CONFIGS = [
  ['atención sola (ventana NULL)', 15, week((d) => (d === 'saturday' || d === 'sunday' ? X : t('12:00', '16:00'))), null],
  ['ventana dentro de la atención', 30, week(() => t('11:00', '23:00')), week((d) => (d === 'monday' ? t('13:00', '15:30') : d === 'tuesday' ? X : t('12:00', '14:00')))],
  ['varios turnos y grilla desde la ventana', 30, week(() => [{ open: '12:00', close: '16:00' }, { open: '19:00', close: '23:00' }]), week(() => [{ open: '12:10', close: '14:00' }, { open: '19:20', close: '22:00' }])],
  ['cruce de medianoche', 15, week((d) => (d === 'friday' || d === 'saturday' ? t('20:00', '02:00') : X)), week((d) => (d === 'friday' ? t('22:00', '01:00') : d === 'saturday' ? t('20:00', '02:00') : X))],
  // La ventana se guardó cuando la atención era 10-20 y después la atención se acortó a 12-16: la intersección la recorta.
  ['ventana que sobresale de la atención (se recorta)', 10, week(() => t('12:00', '16:00')), week(() => t('10:00', '20:00')), week(() => t('10:00', '20:00'))],
  ['día ausente en la ventana = sin reservas', 60, week(() => t('10:00', '22:00')), { wednesday: t('12:00', '15:00') }],
  ['ZZ sin horario', 30, {}, null],
];

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table restaurants (id uuid primary key default gen_random_uuid(), opening_hours jsonb default '{}', slot_interval_minutes int not null default 30,
    slot_duration int default 90, space_capacities jsonb, capacity int);
  create table reservation_blocks (restaurant_id uuid, is_active boolean, start_time timestamptz, end_time timestamptz, blocked_slots int);
  create table reservations (id uuid primary key default gen_random_uuid(), restaurant_id uuid, organizer_id uuid, date_time timestamptz, status text, payment_method text, title text,
    guest_ids uuid[], guest_data jsonb, guests jsonb, party_size int, organizer_reputation_snapshot numeric, user_total_reservations_snapshot int, discount_data_snapshot jsonb,
    applied_discount_id uuid, account_type_snapshot text, benefits_snapshot jsonb, validated_by_user boolean, validated_by_restaurant boolean, special_requests text,
    unique_code text, timestamps jsonb, created_by_staff boolean, metadata jsonb);
  create function restaurant_plan_allows(uuid) returns boolean language sql as 'select true';
  create function restaurant_effective_state(uuid) returns text language sql as 'select 1::text';
  create function operation_limit_check(uuid) returns jsonb language sql as 'select null::jsonb';
  create function inventory_caller_role() returns text language sql as 'select null::text';
`);
await db.exec(migration);

const pad = (n) => String(n).padStart(2, '0');
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
// Oráculo en TS: misma regla que la base, pero con los turnos que calcula getReservationShiftsForDay.
function oracle(opening, reservation, step, dayIdx, prevIdx, offToday, offPrev) {
  for (const [idx, off] of [[dayIdx, offToday], [prevIdx, offPrev]]) {
    for (const s of getReservationShiftsForDay(opening, reservation, idx)) {
      const lo = toMin(s.open);
      let hi = toMin(s.close); if (hi <= lo) hi += 1440;
      const origin = toMin(s.grid_from ?? s.open);
      if (off >= lo && off < hi && (off - origin) % step === 0) return true;
    }
  }
  return false;
}

for (const [name, step, opening, reservation, openingAtInsert] of CONFIGS) {
  const { rows: [{ id }] } = await db.query(`insert into restaurants (opening_hours, reservation_hours, slot_interval_minutes) values ($1,$2,$3) returning id`,
    [JSON.stringify(openingAtInsert ?? opening), reservation == null ? null : JSON.stringify(reservation), step]);
  if (openingAtInsert) await db.query(`update restaurants set opening_hours = $2 where id = $1`, [id, JSON.stringify(opening)]);
  let diffs = 0, trues = 0, first = '';
  for (let day = 0; day < 7; day++) {
    const date = new Date(Date.UTC(2026, 9, 26 + day)); // 2026-10-26 es lunes
    const dow = date.getUTCDay(); const prev = (dow + 6) % 7;
    const ymd = date.toISOString().slice(0, 10);
    for (let m = 0; m < 1440; m += 5) {
      const local = `${ymd} ${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`;
      const { rows: [{ v }] } = await db.query(`select reservation_slot_rule($1, $2::timestamp AT TIME ZONE 'America/Santiago') as v`, [id, local]);
      const exp = oracle(opening, reservation, step, dow, prev, m, m + 1440);
      if (exp) trues++;
      if (v !== exp) { diffs++; if (!first) first = `${local} sql=${v} ts=${exp}`; }
    }
  }
  ok(`${name}: ${trues} horarios válidos, 0 diferencias`, diffs === 0, `${diffs} diferencias; primera: ${first}`);
}
console.log(`\n${pass} pasan, ${fail} fallan`);
process.exit(fail ? 1 : 0);
