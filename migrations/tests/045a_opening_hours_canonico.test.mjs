// Prueba de 045a_opening_hours_canonico.sql sobre PGlite: con las 7 formas REALES de opening_hours (leídas el 2026-10-26),
// el lector TS getOpeningShiftsForDay devuelve los mismos turnos por día antes y después de la migración.
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node migrations/tests/045a_opening_hours_canonico.test.mjs
// (Node >= 22.18 importa el .ts directamente; el lector solo usa sintaxis borrable.)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(dir, '..', '045a_opening_hours_canonico.sql'), 'utf8');
const { getOpeningShiftsForDay } = await import(join(dir, '..', '..', 'src', 'lib', 'core-business', 'restaurant-hours.ts'));
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

const sh = (open, close) => ({ open, close, is_closed: false });
const std = (o, c) => ({ friday: [{ open: o, close: c }], monday: [{ open: o, close: c }], sunday: [{ is_closed: true }], tuesday: [{ open: o, close: c }], saturday: [{ is_closed: true }], thursday: [{ open: o, close: c }], wednesday: [{ open: o, close: c }] });
const zan = {};
for (const k of ['fri', 'mon', 'sat', 'thu', 'tue', 'wed', 'friday', 'monday', 'tuesday', 'saturday', 'thursday', 'wednesday']) zan[k] = sh('09:00', '22:00');
zan.sunday = [{ is_closed: true }];
const cri = {
  fri: sh('12:00', '16:00'), mon: sh('12:00', '21:00'), sun: { open: '09:00', close: '22:00', is_closed: true }, thu: sh('10:00', '16:00'), tue: sh('12:00', '16:00'), wed: sh('12:00', '23:00'),
  friday: sh('12:00', '16:00'), monday: sh('12:00', '21:00'), sunday: { open: '09:00', close: '22:00', is_closed: true }, tuesday: sh('12:00', '16:00'), thursday: sh('10:00', '16:00'), wednesday: sh('12:00', '23:00'),
};
const LOCALES = [
  ['4b739c39-95cd-40e8-8f39-b1af52478d9a', 'Café Barra Fundición', std('11:00', '23:00')],
  ['c8f518ae-2da9-4bb4-a95f-cca4c6b96056', 'Cri-Olla', cri],
  ['884331c1-6fb7-4b05-ac8f-4e6fce81872a', 'La Tabla', std('11:00', '23:00')],
  ['fd4ad00b-f6f3-4962-8c21-5e51b5446e36', 'Lolita Jones', std('11:00', '23:00')],
  ['e9238424-b649-4576-838a-aa9faad2384a', 'PP', std('11:00', '23:00')],
  ['2729b647-33c8-4419-8967-f668ec3ce61d', 'Zanzíbar', zan],
  ['bffb5a0b-5328-449a-bb5b-ff1d3afac84a', 'ZZ PRUEBA Nuevo', {}],
];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const days = (oh) => [0, 1, 2, 3, 4, 5, 6].map((d) => JSON.stringify(getOpeningShiftsForDay(oh, d).map((s) => [s.open, s.close])));
const read = async () => Object.fromEntries((await db.query('select id, opening_hours from restaurants')).rows.map((r) => [r.id, r.opening_hours]));

await db.exec(`create table restaurants (id uuid primary key, name text, opening_hours jsonb, operating_hours jsonb);`);
for (const [id, name, oh] of LOCALES) await db.query('insert into restaurants (id, name, opening_hours, operating_hours) values ($1,$2,$3,$4)', [id, name, JSON.stringify(oh), JSON.stringify({ marca: name })]);

const before = await read();
await db.exec(migration);
const after = await read();

const CANON = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
for (const [id, name] of LOCALES) {
  ok(`${name}: turnos por día idénticos antes/después`, JSON.stringify(days(before[id])) === JSON.stringify(days(after[id])), `${days(before[id])} vs ${days(after[id])}`);
  const keys = Object.keys(after[id]);
  if (name.startsWith('ZZ')) ok(`${name}: queda {}`, keys.length === 0);
  else {
    ok(`${name}: solo claves largas, las 7`, keys.length === 7 && CANON.every((k) => keys.includes(k)));
    ok(`${name}: cada día es arreglo de turnos`, CANON.every((k) => Array.isArray(after[id][k]) && after[id][k].length >= 1 && after[id][k].every((t) => t.is_closed === true ? Object.keys(t).length === 1 : (t.open && t.close && Object.keys(t).length === 2))));
  }
}
const cri2 = after['c8f518ae-2da9-4bb4-a95f-cca4c6b96056'];
ok('Cri-Olla: sábado y domingo cerrados', days(cri2)[6] === '[]' && days(cri2)[0] === '[]');
ok('Cri-Olla: lunes 12-21', days(cri2)[1] === '[["12:00","21:00"]]');
ok('Los 4 ya canónicos no cambiaron', ['4b739c39-95cd-40e8-8f39-b1af52478d9a', '884331c1-6fb7-4b05-ac8f-4e6fce81872a', 'fd4ad00b-f6f3-4962-8c21-5e51b5446e36', 'e9238424-b649-4576-838a-aa9faad2384a'].every((id) => JSON.stringify(before[id]) === JSON.stringify(after[id])));
ok('operating_hours intacto', (await db.query(`select count(*)::int n from restaurants where operating_hours is distinct from jsonb_build_object('marca', name)`)).rows[0].n === 0);

// idempotencia
await db.exec(migration);
ok('segunda ejecución no cambia nada', JSON.stringify(await read()) === JSON.stringify(after));

// guarda: si el valor actual no es el esperado, se omite
await db.exec(`update restaurants set opening_hours = '{"monday":[{"open":"08:00","close":"10:00"}]}' where name = 'Zanzíbar'`);
const edited = JSON.stringify(await read());
await db.exec(migration);
ok('no pisa una edición posterior', JSON.stringify(await read()) === edited);

console.log(`\n${pass} pasan, ${fail} fallan`);
process.exit(fail ? 1 : 0);
