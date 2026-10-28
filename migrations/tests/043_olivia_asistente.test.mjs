// Pruebas de 043_olivia_asistente.sql sobre PGlite (Postgres en WASM, un solo proceso).
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node 043_olivia_asistente.test.mjs
// NO prueba concurrencia real (PGlite es de una sola conexión): se verifica que el esquema, las reglas y los permisos sean los
// esperados; la carrera de dos conexiones se razona por el candado advisory por usuario, no se ejecuta aquí.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(dir, '..', '043_olivia_asistente.sql'), 'utf8');
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const UE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const R1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const asRole = async (role, fn) => {
  await db.exec(`set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
};
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------- esquema stub (solo lo que toca la migración) ----------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create table profiles (id uuid primary key, account_type text not null default 'free');
  create table restaurants (id uuid primary key default gen_random_uuid(), name text, description text, is_active boolean default true,
    plan_hidden boolean default false, cuisine_type text, price_level int, address jsonb, comuna text, lat double precision, lng double precision,
    amenities text[], spaces text[], capacity int, space_capacities jsonb, opening_hours jsonb, has_takeaway boolean, has_reservations boolean,
    average_prep_time int, phone text);
  create table menu_items (id uuid primary key default gen_random_uuid(), restaurant_id uuid, name text, description text, price int,
    takeaway_price int, category text, is_available boolean default true, is_available_for_takeaway boolean default true,
    is_menu_del_dia boolean default false, disabled_by_stock boolean default false, stock_managed boolean default false, current_stock int default 0);
  insert into profiles (id, account_type) values ('${U1}','free'), ('${U2}','free'), ('${UE}','elite');
  insert into restaurants (id, name) values ('${R1}', 'Local de prueba');
  insert into menu_items (restaurant_id, name, price, stock_managed, current_stock) values ('${R1}', 'Cazuela', 5500, true, 4);
`);
await db.exec(migration);

const NOW = '2026-10-27T15:00:00Z'; // 12:00 en Santiago (UTC-3)
const reserve = (u, at = NOW) => asRole('service_role', async () => (await one(`select public.olivia_reserve($1, $2) r`, [u, at])).r);
const usage = (u, at = NOW) => asRole('service_role', async () => (await one(`select public.olivia_usage($1, $2) r`, [u, at])).r);
const finish = (id, st, i = 1000, o = 200) => asRole('service_role', async () => (await one(`select public.olivia_finish($1, $2, $3, $4) c`, [id, st, i, o])).c);

// ---------- interruptor ----------
ok('config nace apagada, 3 por día, USD 5', JSON.stringify(await one(`select enabled, daily_limit, monthly_budget_usd::float m from olivia_config`)) === '{"enabled":false,"daily_limit":3,"m":5}');
let r = await reserve(U1);
ok('apagada: rechaza con code disabled y no escribe', r.ok === false && r.code === 'disabled' && (await one(`select count(*)::int n from olivia_usage`)).n === 0);
ok('apagada: olivia_usage informa enabled=false', (await usage(U1)).enabled === false);
await db.exec(`update olivia_config set enabled = true`);

// ---------- tope diario ----------
r = await reserve(U1);
ok('1ª consulta pasa, quedan 2', r.ok && r.used === 1 && r.remaining === 2 && r.daily_limit === 3 && r.model === 'claude-haiku-5-5');
const id1 = r.id;
ok('devuelve el reinicio: medianoche de Santiago', r.resets_at === '2026-10-28T03:00:00+00:00' || new Date(r.resets_at).toISOString() === '2026-10-28T03:00:00.000Z', r.resets_at);
const cost = await finish(id1, 'ok', 1000, 200);
ok('costo = tokens x precio por millón (1000 in + 200 out = 0.0002 con 0,10/0,50)', Math.abs(Number(cost) - 0.0002) < 1e-9, String(cost));
r = await reserve(U1); await finish(r.id, 'ok');
r = await reserve(U1); await finish(r.id, 'ok');
ok('3 consultas usadas, 0 restantes', (await usage(U1)).used === 3 && (await usage(U1)).remaining === 0);
r = await reserve(U1);
ok('4ª consulta del día: limit_reached con detalle', r.ok === false && r.code === 'limit_reached' && r.used === 3 && r.remaining === 0);
ok('rechazada no escribe fila', (await one(`select count(*)::int n from olivia_usage where user_id='${U1}'`)).n === 3);
r = await reserve(U2);
ok('otro usuario tiene su propio tope', r.ok && r.used === 1);
await finish(r.id, 'ok');
r = await reserve(UE);
ok('Elite tiene el mismo tope (3), no ilimitado', r.ok); await finish(r.id, 'ok');
r = await reserve(UE); await finish(r.id, 'ok'); r = await reserve(UE); await finish(r.id, 'ok');
r = await reserve(UE);
ok('Elite: la 4ª también se rechaza', r.ok === false && r.code === 'limit_reached');

// ---------- reinicio a medianoche de Santiago ----------
r = await reserve(U1, '2026-10-28T02:59:00Z'); // 23:59 del 27 en Santiago
ok('23:59 de Santiago sigue siendo el mismo día (sigue en tope)', r.ok === false && r.code === 'limit_reached');
r = await reserve(U1, '2026-10-28T03:01:00Z'); // 00:01 del 28
ok('00:01 de Santiago es otro día: vuelve a tener 3', r.ok === true && r.used === 1 && r.remaining === 2);
await finish(r.id, 'ok');

// ---------- fallida no cuenta; reservada vieja deja de contar ----------
r = await reserve(U2, '2026-10-29T15:00:00Z'); const failId = r.id;
ok('en vuelo cuenta', (await usage(U2, '2026-10-29T15:00:30Z')).used === 1);
await finish(failId, 'fallida', 0, 0);
ok('fallida no cuenta ni gasta', (await usage(U2, '2026-10-29T15:00:30Z')).used === 0 && Number((await one(`select cost_usd from olivia_usage where id=$1`, [failId])).cost_usd) === 0);
r = await reserve(U2, '2026-10-30T15:00:00Z');
ok('reservada sin cerrar cuenta antes de 3 min', (await usage(U2, '2026-10-30T15:02:00Z')).used === 1);
ok('reservada sin cerrar deja de contar a los 3 min', (await usage(U2, '2026-10-30T15:04:00Z')).used === 0);
ok('olivia_finish no reabre una consulta ya cerrada', (await finish(failId, 'ok', 5000, 5000), Number((await one(`select cost_usd from olivia_usage where id=$1`, [failId])).cost_usd) === 0));
ok('estado inválido se rechaza', (await fails(() => finish(id1, 'otro'))) !== null);

// ---------- tope mensual de gasto ----------
await db.exec(`delete from olivia_usage; update olivia_config set monthly_budget_usd = 0.05, per_query_reserve_usd = 0.02, input_usd_per_mtok = 1, output_usd_per_mtok = 5`);
r = await reserve(U1, '2026-11-02T15:00:00Z'); await finish(r.id, 'ok', 10000, 4000); // 0.03
ok('gasto del mes se suma', Math.abs(Number((await one(`select public.olivia_month_spend('2026-11-02T16:00:00Z') s`)).s) - 0.03) < 1e-9);
r = await reserve(U2, '2026-11-02T16:00:00Z');
ok('0.03 + reserva 0.02 = 0.05 todavía cabe', r.ok === true); await finish(r.id, 'ok', 10000, 4000); // 0.06 total
r = await reserve(UE, '2026-11-02T17:00:00Z');
ok('presupuesto agotado: budget_exhausted', r.ok === false && r.code === 'budget_exhausted');
ok('olivia_usage avisa budget_exhausted', (await usage(UE, '2026-11-02T17:00:00Z')).budget_exhausted === true);
r = await reserve(UE, '2026-12-01T15:00:00Z');
ok('mes nuevo (Santiago): el gasto parte de cero', r.ok === true);
await db.exec(`delete from olivia_usage; update olivia_config set monthly_budget_usd = 5, input_usd_per_mtok = 0.10, output_usd_per_mtok = 0.50, per_query_reserve_usd = 0.005`);

// ---------- copias del día: marcar desactualizadas por excepción ----------
const today = (await one(`select public.olivia_day(now())::text d`)).d;
await db.exec(`insert into olivia_snapshots (day, kind, payload) values ('${today}','offer','{}'), ('${today}','venues','{}'), ('${today}','weather','{}')`);
const stale = async () => Object.fromEntries((await q(`select kind, stale from olivia_snapshots where day = '${today}'`)).map(x => [x.kind, x.stale]));
const reset = () => db.exec(`update olivia_snapshots set stale = false`);

await db.exec(`update menu_items set current_stock = 3`);
ok('descontar stock sin llegar a 0 NO marca la oferta', (await stale()).offer === false);
await db.exec(`update menu_items set current_stock = 0`);
ok('agotarse marca la oferta', (await stale()).offer === true);
ok('…y no toca ficha ni pronóstico', (await stale()).venues === false && (await stale()).weather === false);
await reset();
await db.exec(`update menu_items set price = 6000`);
ok('cambiar un precio marca la oferta', (await stale()).offer === true); await reset();
await db.exec(`update menu_items set is_available = false`);
ok('apagar un plato marca la oferta', (await stale()).offer === true); await reset();
await db.exec(`insert into menu_items (restaurant_id, name, price) values ('${R1}', 'Pastel', 5000)`);
ok('crear un plato marca la oferta', (await stale()).offer === true); await reset();
await db.exec(`delete from menu_items where name = 'Pastel'`);
ok('borrar un plato marca la oferta', (await stale()).offer === true); await reset();
await db.exec(`update restaurants set amenities = array['Terraza']`);
ok('cambiar atributos del local marca oferta y ficha', (await stale()).offer && (await stale()).venues && !(await stale()).weather); await reset();
await db.exec(`update restaurants set phone = '123'`);
ok('un campo que no ve OlivIA (teléfono) no marca nada', !(await stale()).offer && !(await stale()).venues);
await db.exec(`update restaurants set plan_hidden = true`);
ok('ocultarse por plan marca oferta y ficha', (await stale()).offer && (await stale()).venues); await reset();
await db.exec(`update olivia_snapshots set day = day - 1`);
await db.exec(`update menu_items set price = 7000`);
ok('copias de otro día no se tocan', (await q(`select 1 from olivia_snapshots where stale`)).length === 0);

// ---------- permisos ----------
for (const role of ['anon', 'authenticated']) {
  for (const t of ['olivia_config', 'olivia_usage', 'olivia_snapshots']) {
    const e = await asRole(role, () => fails(() => q(`select * from ${t}`)));
    ok(`${role} no lee ${t}`, e && /permission denied/.test(e.message), e?.message);
  }
  for (const fn of [`olivia_reserve('${U1}')`, `olivia_usage('${U1}')`, `olivia_finish('${id1}','ok')`, `olivia_month_spend()`, `olivia_mark_stale(array['offer'])`]) {
    const e = await asRole(role, () => fails(() => q(`select public.${fn}`)));
    ok(`${role} no ejecuta ${fn.split('(')[0]}`, e && /permission denied/.test(e.message), e?.message);
  }
}
const svc = await asRole('service_role', async () => ({ c: await q(`select enabled from olivia_config`), s: await q(`select 1 from olivia_snapshots limit 1`) }));
ok('service_role sí lee config y copias', svc.c.length === 1 && svc.s.length >= 0);
const insCfg = await asRole('service_role', () => fails(() => q(`insert into olivia_config (singleton) values (false)`)));
ok('service_role no inserta en config (solo SELECT/UPDATE)', insCfg && /permission denied/.test(insCfg.message));
const rls = await q(`select relname, relrowsecurity from pg_class where relname in ('olivia_config','olivia_usage','olivia_snapshots')`);
ok('RLS activa en las 3 tablas', rls.length === 3 && rls.every(x => x.relrowsecurity));
ok('olivia_usage borra al borrarse el perfil', (await (async () => { await reserve(U2, '2026-12-05T15:00:00Z'); await db.exec(`delete from profiles where id='${U2}'`); return (await one(`select count(*)::int n from olivia_usage where user_id='${U2}'`)).n === 0; })()));

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
