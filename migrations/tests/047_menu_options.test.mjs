// Pruebas de 047_menu_options.sql sobre PGlite (Postgres en WASM, un solo proceso), incluida la PARIDAD TS <-> SQL
// de la regla de selección/precio (src/lib/menu-options.ts vs trigger takeaway_price_guard).
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node migrations/tests/047_menu_options.test.mjs   (Node >= 22.18)
// No prueba concurrencia real ni los grants automáticos de Supabase: tras aplicar hay que verificar role_table_grants / proacl en la base real.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const m046 = readFileSync(join(dir, '..', '046_menu_categories.sql'), 'utf8');
const m047 = readFileSync(join(dir, '..', '047_menu_options.sql'), 'utf8');
const rules = await import(join(dir, '..', '..', 'src', 'lib', 'menu-options.ts'));
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e; } };

const R1 = '11111111-1111-1111-1111-111111111111';
const R2 = '22222222-2222-2222-2222-222222222222';
const U = '99999999-9999-9999-9999-999999999999';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P1 = uid(1), P2 = uid(2), P3 = uid(3), P4 = uid(4);

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table restaurants (id uuid primary key, name text);
  create table menu_items (id uuid primary key default gen_random_uuid(), restaurant_id uuid references restaurants(id), name text not null,
    category text not null default 'General', price integer not null, takeaway_price integer, created_at timestamptz not null default now());
  create table takeaway_orders (id uuid primary key default gen_random_uuid(), user_id uuid, restaurant_id uuid, items jsonb not null default '[]', total_amount integer not null, status text default 'PENDIENTE');
`);
await db.exec(m046);
await db.exec(m047);
await db.query(`insert into restaurants values ($1,'Cri-Olla'),($2,'Otro')`, [R1, R2]);
await db.query(`insert into menu_items (id, restaurant_id, name, price, takeaway_price) values ($1,$2,'Pastel',6900,6500),($3,$2,'Bebida',3000,0),($4,$5,'Ajeno',1000,null),($6,$2,'Sin grupos 2',1500,1500)`, [P1, R1, P2, P3, R2, P4]);

const mkGroup = async (rest, name, kind, required, min, max) =>
  (await q(`insert into menu_option_groups (restaurant_id,name,kind,required,min_select,max_select) values ($1,$2,$3,$4,$5,$6) returning id`, [rest, name, kind, required, min, max]))[0].id;
const mkOpt = async (g, name, delta, avail = true, pos = 0) =>
  (await q(`insert into menu_options (group_id,name,price_delta,is_available,position) values ($1,$2,$3,$4,$5) returning id`, [g, name, delta, avail, pos]))[0].id;

const GA = await mkGroup(R1, 'Acompañamiento', 'single', true, 1, 1);
const papas = await mkOpt(GA, 'Papas fritas', 0, true, 0), arroz = await mkOpt(GA, 'Arroz', 0, true, 1), ensalada = await mkOpt(GA, 'Ensalada', 500, false, 2);
const GE = await mkGroup(R1, 'Agregados', 'multiple', false, 0, 2);
const queso = await mkOpt(GE, 'Queso', 800, true, 0), palta = await mkOpt(GE, 'Palta', 1200, true, 1), huevo = await mkOpt(GE, 'Huevo', 600, true, 2);
const GC = await mkGroup(R1, 'Punto', 'single', false, 0, 1);
const medio = await mkOpt(GC, 'Medio', 0, true, 0), bien = await mkOpt(GC, 'Bien cocido', 0, true, 1);
await db.query(`select menu_set_item_groups($1, $2::uuid[])`, [P1, [GA, GE, GC]]);
// Grupo de otro plato (P2) y otro restaurante.
const GB = await mkGroup(R1, 'Hielo', 'single', false, 0, 1);
const sinHielo = await mkOpt(GB, 'Sin hielo', 0);
await db.query(`select menu_set_item_groups($1, $2::uuid[])`, [P2, [GB]]);
const GX = await mkGroup(R2, 'Extra ajeno', 'single', false, 0, 1);
const ajena = await mkOpt(GX, 'Ajena', 100);

const order = (items, total, rest = R1) => db.query(`insert into takeaway_orders (user_id, restaurant_id, items, total_amount) values ($1,$2,$3,$4) returning items`, [U, rest, JSON.stringify(items), total]);
const line = (id, quantity, options, extra = {}) => ({ id, name: 'x', price: 1, quantity, options, imageUrl: 'u.png', ...extra });
const hint = async (items, total, rest) => { const e = await err(`insert into takeaway_orders (user_id, restaurant_id, items, total_amount) values ($1,$2,$3,$4)`, [U, rest ?? R1, JSON.stringify(items), total]); return e ? (e.hint ?? 'ERR:' + e.message) : null; };
const setOn = (on) => db.exec(`update price_enforcement set enabled = ${on}`);

// ---- interruptor apagado ----
ok('interruptor nace apagado y con una sola fila', (await q(`select enabled from price_enforcement`)).length === 1 && (await q(`select enabled from price_enforcement`))[0].enabled === false);
const off = await order([line(P1, 1, [])], 1);
ok('apagado: no valida ni reescribe nada', off.rows[0].items[0].price === 1 && !('base_price' in off.rows[0].items[0]));
await setOn(true);

// ---- caminos felices y snapshot ----
let r = (await order([line(P2, 3, [])], 9000)).rows[0].items;
ok('plato sin grupos: base = precio local si takeaway_price es 0 (3 x 3000)', r[0].price === 3000 && r[0].unit_price === 3000 && r[0].base_price === 3000 && Array.isArray(r[0].options) && r[0].options.length === 0);
r = (await order([line(P1, 1, [{ option_id: papas }])], 6500)).rows[0].items;
ok('opción gratuita no suma: 6500', r[0].unit_price === 6500 && r[0].options.length === 1 && r[0].options[0].price_delta === 0);
r = (await order([line(P1, 2, [{ option_id: arroz }, { option_id: queso }, { option_id: palta }, { option_id: medio }])], 17000)).rows[0].items;
ok('recargos suman: (6500+800+1200) x 2 = 17000', r[0].unit_price === 8500 && r[0].price === 8500 && r[0].base_price === 6500);
ok('snapshot trae nombres y recargos del momento', r[0].options.some((o) => o.name === 'Queso' && o.price_delta === 800 && o.group_name === 'Agregados' && o.option_id === queso));
ok('snapshot ordenado por grupo del plato y orden de la opción', r[0].options.map((o) => o.name).join() === 'Arroz,Queso,Palta,Medio', r[0].options.map((o) => o.name).join());
ok('conserva campos del cliente (imageUrl) y reescribe nombre', r[0].imageUrl === 'u.png' && r[0].name === 'Pastel');
ok('opciones como ids planos (string)', (await order([line(P1, 1, [papas, huevo])], 7100)).rows[0].items[0].unit_price === 7100);
ok('items como string JSON', (await q(`select 1`)) && (await db.query(`insert into takeaway_orders (user_id, restaurant_id, items, total_amount) values ($1,$2,$3::jsonb,$4) returning items`, [U, R1, JSON.stringify(JSON.stringify([line(P2, 1, [])])), 3000])).rows[0].items[0].unit_price === 3000);
r = (await order([line(P1, 1, [papas]), line(P2, 2, [])], 6500 + 6000)).rows[0].items;
ok('varias líneas suman', r.length === 2 && r[1].unit_price === 3000);
ok('el precio de línea que manda el cliente se IGNORA (se recalcula)', (await order([line(P2, 1, [], { price: 1 })], 3000)).rows[0].items[0].price === 3000);

// ---- rechazos ----
ok('total manipulado hacia abajo => price_mismatch', await hint([line(P1, 1, [{ option_id: queso }, { option_id: papas }])], 6500) === 'price_mismatch');
ok('total manipulado en plato sin opciones => price_mismatch', await hint([line(P2, 1, [])], 100) === 'price_mismatch');
const mm = await err(`insert into takeaway_orders (user_id, restaurant_id, items, total_amount) values ($1,$2,$3,$4)`, [U, R1, JSON.stringify([line(P1, 1, [papas, queso])]), 1]);
const detail = JSON.parse(mm.detail);
ok('price_mismatch entrega total esperado y líneas para refrescar el carrito', detail.expected_total === 7300 && detail.items[0].unit_price === 7300);
ok('opción apagada no se puede elegir', await hint([line(P1, 1, [ensalada])], 7000) === 'option_unavailable');
ok('opción de otro plato (grupo no asignado a este plato)', await hint([line(P1, 1, [papas, sinHielo])], 6500) === 'option_invalid');
ok('opción de otro restaurante', await hint([line(P1, 1, [papas, ajena])], 6600) === 'option_invalid');
ok('opción inexistente', await hint([line(P1, 1, [papas, uid(777)])], 6500) === 'option_invalid');
ok('id de opción que no es uuid', await hint([line(P1, 1, [papas, 'xx'])], 6500) === 'option_invalid');
ok('opciones que no son arreglo', await hint([line(P1, 1, 'papas')], 6500) === 'option_invalid');
ok('opción repetida', await hint([line(P1, 1, [papas, papas])], 6500) === 'option_duplicate');
ok('obligatorio sin elegir => option_min', await hint([line(P1, 1, [])], 6500) === 'option_min');
ok('obligatorio con solo opción de otro grupo => option_min', await hint([line(P1, 1, [queso])], 7300) === 'option_min');
ok('elegir una: dos en un grupo single => option_max', await hint([line(P1, 1, [papas, arroz])], 6500) === 'option_max');
ok('máximo 2 en «varias»: 3 extras => option_max', await hint([line(P1, 1, [papas, queso, palta, huevo])], 9100) === 'option_max');
ok('máximo 2 en «varias»: exactamente 2 es válido', await hint([line(P1, 1, [papas, queso, palta])], 8500) === null);
ok('cantidad 0, decimal, texto, ausente o 101 => invalid_quantity', (await Promise.all([0, 1.5, 'x', null, 101].map((qty) => hint([{ id: P2, quantity: qty }], 3000)))).every((h) => h === 'invalid_quantity'));
ok('plato de otro restaurante => item_not_found', await hint([line(P3, 1, [])], 1000) === 'item_not_found');
ok('plato inexistente o sin id => item_not_found', await hint([line(uid(555), 1, [])], 1) === 'item_not_found' && await hint([{ quantity: 1 }], 1) === 'item_not_found');
ok('pedido vacío o sin arreglo => empty_order', await hint([], 0) === 'empty_order' && await hint({}, 0) === 'empty_order');
ok('un grupo OPCIONAL no exige nada y 0 opciones es válido en plato sin grupos obligatorios', await hint([line(P4, 1, [])], 1500) === null);

// ---- el snapshot no cambia si luego se edita o borra la opción ----
const frozen = (await order([line(P1, 1, [papas, queso])], 7300)).rows[0].items;
await db.query(`update menu_options set price_delta = 9999, name = 'Queso gruyère' where id = $1`, [queso]);
await db.query(`delete from menu_options where id = $1`, [queso]);
const stored = (await q(`select items from takeaway_orders where items @> $1::jsonb`, [JSON.stringify([{ unit_price: 7300 }])]))[0].items;
ok('pedido histórico intacto tras editar y borrar la opción', JSON.stringify(stored) === JSON.stringify(frozen));
const queso2 = await mkOpt(GE, 'Queso', 800, true, 0);

// ---- orden de disparo de los triggers ----
const names = (await q(`select tgname from pg_trigger where tgrelid='takeaway_orders'::regclass and not tgisinternal`)).map((x) => x.tgname);
const simulated = [...names, 'tr_00_a_plan_guard', 'tr_00_b_operation_guard', 'tr_00_inventory_guard', 'tr_auto_approve_takeaway_order'].sort();
ok('el guard de precio dispara después del tope de operaciones y antes del stock y la autoaprobación',
  simulated.indexOf('tr_00_b_operation_guard') < simulated.indexOf('tr_00_c_price_guard') && simulated.indexOf('tr_00_c_price_guard') < simulated.indexOf('tr_00_inventory_guard') && simulated.indexOf('tr_00_c_price_guard') < simulated.indexOf('tr_auto_approve_takeaway_order'));

// ---- PARIDAD TS <-> SQL ----
const optsOf = async (gid) => (await q(`select id, name, price_delta, is_available from menu_options where group_id=$1 order by position, name`, [gid])).map((o) => ({ ...o }));
const groupsP1 = async () => {
  const rows = await q(`select g.* from menu_item_option_groups ig join menu_option_groups g on g.id=ig.group_id where ig.item_id=$1 order by ig.position`, [P1]);
  return Promise.all(rows.map(async (g) => ({ id: g.id, name: g.name, kind: g.kind, required: g.required, min_select: g.min_select, max_select: g.max_select, options: await optsOf(g.id) })));
};
await db.query(`update menu_options set is_available=false where id=$1`, [huevo]); // una más apagada para cubrir mezclas
const groups = await groupsP1();
const allIds = groups.flatMap((g) => g.options.map((o) => o.id));
let mismatches = 0, cases = 0;
for (let mask = 0; mask < (1 << allIds.length); mask++) {
  const sel = allIds.filter((_, i) => mask & (1 << i));
  for (const order_ of [sel, [...sel].reverse()]) {
    cases++;
    const ts = rules.validateSelection(groups, order_);
    const total = ts ? 0 : rules.unitPrice(6500, groups, order_);
    const sql = await hint([line(P1, 1, order_)], total);
    if ((ts ? ts.code : null) !== sql) { mismatches++; console.log('  paridad distinta:', order_.length, 'ts=', ts?.code ?? 'ok', 'sql=', sql); }
  }
}
ok(`paridad TS <-> SQL en ${cases} selecciones (todas las combinaciones, dos órdenes)`, mismatches === 0, `${mismatches} distintas`);
ok('baseUnitPrice (TS) = base de la base de datos (takeaway 0 => local)', rules.baseUnitPrice({ price: 3000, takeaway_price: 0 }) === 3000 && rules.baseUnitPrice({ price: 6900, takeaway_price: 6500 }) === 6500 && rules.baseUnitPrice({ price: 100, takeaway_price: null }) === 100);

// ---- restricciones de las tablas ----
const cons = async (sql, params) => { const e = await err(sql, params); return e ? e.message : null; };
const g = (name, kind, required, min, max) => cons(`insert into menu_option_groups (restaurant_id,name,kind,required,min_select,max_select) values ($1,$2,$3,$4,$5,$6)`, [R1, name, kind, required, min, max]);
ok('grupo: obligatorio inconsistente con el mínimo', /menu_option_groups_required/.test(await g('a1', 'multiple', true, 0, 2) ?? ''));
ok('grupo: «una» con máximo 2', /menu_option_groups_single/.test(await g('a2', 'single', false, 0, 2) ?? ''));
ok('grupo: mínimo > máximo', /menu_option_groups_range/.test(await g('a3', 'multiple', true, 3, 2) ?? ''));
ok('grupo: máximo 21', /menu_option_groups_range/.test(await g('a4', 'multiple', false, 0, 21) ?? ''));
ok('grupo: tipo inválido', (await g('a5', 'otro', false, 0, 1)) !== null);
ok('grupo: nombre repetido (normalizado)', /duplicate key/.test(await g('acompanamiento', 'single', false, 0, 1) ?? ''));
ok('grupo: nombre vacío', (await g('  ', 'single', false, 0, 1)) !== null);
ok('grupo múltiple válido (min 1, max 3)', (await g('Salsas', 'multiple', true, 1, 3)) === null);
const o = (name, delta, group = GE) => cons(`insert into menu_options (group_id,name,price_delta) values ($1,$2,$3)`, [group, name, delta]);
ok('opción: recargo negativo', (await o('n1', -1)) !== null);
ok('opción: recargo > 1.000.000', (await o('n2', 1000001)) !== null);
ok('opción: recargo 1.000.000 y 0 válidos', (await o('n3', 1000000)) === null && (await o('n4', 0)) === null);
ok('opción: nombre repetido en el grupo', /duplicate key/.test(await o('queso', 5) ?? ''));
ok('opción: mismo nombre en otro grupo permitido', (await o('Queso', 5, GC)) === null);
ok('asignación entre restaurantes rechazada', /no pertenece/.test(await cons(`insert into menu_item_option_groups (item_id, group_id) values ($1,$2)`, [P1, GX]) ?? ''));
ok('menu_set_item_groups con grupo ajeno falla; vacía quita todos', (await cons(`select menu_set_item_groups($1,$2::uuid[])`, [P4, [GX]])) !== null
  && (await cons(`select menu_set_item_groups($1,$2::uuid[])`, [P4, [GA]])) === null && (await cons(`select menu_set_item_groups($1,'{}'::uuid[])`, [P4])) === null
  && (await q(`select count(*)::int n from menu_item_option_groups where item_id=$1`, [P4]))[0].n === 0);
ok('menu_set_item_groups con repetidos falla', (await cons(`select menu_set_item_groups($1,$2::uuid[])`, [P4, [GA, GA]])) !== null);
const save = (grp, name, kind, req, min, max, opts, rest = R1) => db.query(`select menu_save_option_group($1,$2,$3,$4,$5,$6,$7,$8::jsonb) id`, [rest, grp, name, kind, req, min, max, JSON.stringify(opts)]);
const gid = (await save(null, 'Salsas dulces', 'multiple', false, 0, 2, [{ name: 'Miel', price_delta: 300 }, { name: 'Mostaza', price_delta: 0, is_available: false }])).rows[0].id;
const sv = await q(`select id, name, price_delta, is_available, position from menu_options where group_id=$1 order by position`, [gid]);
ok('guardar grupo nuevo crea grupo y opciones en orden', sv.length === 2 && sv[0].name === 'Miel' && sv[0].position === 0 && sv[1].is_available === false && sv[1].position === 1);
await save(gid, 'Dips', 'multiple', true, 1, 3, [{ id: sv[1].id, name: 'Mostaza antigua', price_delta: 100, is_available: true }, { name: 'Ají', price_delta: 0 }]);
const sv2 = await q(`select id, name, price_delta, position from menu_options where group_id=$1 order by position`, [gid]);
ok('guardar de nuevo: actualiza por id, crea nuevas, borra las que no vienen y reordena', sv2.map((o) => o.name).join() === 'Mostaza antigua,Ají' && sv2[0].id === sv[1].id && sv2[0].price_delta === 100);
ok('guardar actualiza la configuración del grupo', (await q(`select name, required, min_select, max_select from menu_option_groups where id=$1`, [gid]))[0].required === true);
ok('guardar con opción ajena al grupo falla y no deja cambios', (await cons(`select menu_save_option_group($1,$2,'Dips','multiple',true,1,3,$3::jsonb)`, [R1, gid, JSON.stringify([{ id: papas, name: 'x', price_delta: 0 }])])) !== null
  && (await q(`select count(*)::int n from menu_options where group_id=$1`, [gid]))[0].n === 2);
ok('guardar en otro restaurante falla', /no existe en este restaurante/.test(await cons(`select menu_save_option_group($1,$2,'Dips','multiple',true,1,3,'[]'::jsonb)`, [R2, gid]) ?? ''));
ok('guardar con configuración inválida falla (obligatorio sin mínimo)', /menu_option_groups_required/.test(await cons(`select menu_save_option_group($1,NULL,'Mala','multiple',true,0,2,'[]'::jsonb)`, [R1]) ?? ''));
ok('guardar rechaza recargo negativo, decimal o no numérico y más de 50 opciones', (await Promise.all([-1, 1.5, '5', null].map((d) => cons(`select menu_save_option_group($1,$2,'Dips','multiple',true,1,3,$3::jsonb)`, [R1, gid, JSON.stringify([{ name: 'z', price_delta: d }])])))).every((m) => m !== null)
  && (await cons(`select menu_save_option_group($1,$2,'Dips','multiple',true,1,3,$3::jsonb)`, [R1, gid, JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ name: 'o' + i, price_delta: 0 })))])) !== null);
ok('guardar sin opciones: grupo sin opciones', (await cons(`select menu_save_option_group($1,NULL,'Vacío','single',false,0,1,'[]'::jsonb)`, [R1])) === null);
ok('borrar un grupo borra sus opciones y asignaciones (cascada)', await (async () => { await db.query(`delete from menu_option_groups where id=$1`, [GB]); return (await q(`select count(*)::int n from menu_options where group_id=$1`, [GB]))[0].n === 0 && (await q(`select count(*)::int n from menu_item_option_groups where group_id=$1`, [GB]))[0].n === 0; })());

// ---- permisos ----
const priv = async (role, table, p) => (await q(`select has_table_privilege($1,$2,$3) v`, [role, table, p]))[0].v;
const T3 = ['menu_option_groups', 'menu_options', 'menu_item_option_groups'];
ok('anon/authenticated: solo SELECT en las 3 tablas', (await Promise.all(T3.flatMap((t) => [priv('anon', t, 'SELECT'), priv('authenticated', t, 'SELECT')]))).every(Boolean)
  && !(await Promise.all(T3.flatMap((t) => ['INSERT', 'UPDATE', 'DELETE'].flatMap((p) => [priv('anon', t, p), priv('authenticated', t, p)])))).some(Boolean));
ok('service_role: CRUD sin TRUNCATE/REFERENCES/TRIGGER', (await Promise.all(T3.map(async (t) => (await priv('service_role', t, 'INSERT')) && (await priv('service_role', t, 'DELETE')) && !(await priv('service_role', t, 'TRUNCATE')) && !(await priv('service_role', t, 'TRIGGER'))))).every(Boolean));
ok('price_enforcement: anon/authenticated sin acceso; service_role SELECT y UPDATE (no INSERT/DELETE)', !(await priv('anon', 'price_enforcement', 'SELECT')) && !(await priv('authenticated', 'price_enforcement', 'SELECT'))
  && await priv('service_role', 'price_enforcement', 'UPDATE') && !(await priv('service_role', 'price_enforcement', 'INSERT')) && !(await priv('service_role', 'price_enforcement', 'DELETE')));
const fx = async (role, fn) => (await q(`select has_function_privilege($1,$2,'EXECUTE') v`, [role, fn]))[0].v;
const SAVE = 'menu_save_option_group(uuid,uuid,text,text,boolean,integer,integer,jsonb)';
ok('RPC: solo service_role ejecuta', await fx('service_role', SAVE) && !(await fx('anon', SAVE)) && !(await fx('authenticated', SAVE)) && !(await fx('authenticated', 'menu_set_item_groups(uuid,uuid[])')) && await fx('service_role', 'menu_set_item_groups(uuid,uuid[])'));
ok('funciones de trigger sin ejecución para anon/authenticated', !(await fx('anon', 'takeaway_price_guard()')) && !(await fx('authenticated', 'takeaway_price_guard()')));
ok('RLS activa con una política SELECT por tabla', (await q(`select count(*)::int n from pg_class where relname in ('menu_option_groups','menu_options','menu_item_option_groups','price_enforcement') and relrowsecurity`))[0].n === 4
  && (await q(`select count(*)::int n from pg_policies where tablename in ('menu_option_groups','menu_options','menu_item_option_groups')`))[0].n === 3);

console.log(`\n${pass} pasan, ${fail} fallan`);
process.exit(fail ? 1 : 0);
