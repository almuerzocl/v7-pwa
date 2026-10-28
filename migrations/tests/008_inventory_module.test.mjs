// Pruebas funcionales de 008_inventory_module.sql sobre PGlite (Postgres en WASM, un solo proceso).
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node 008_inventory_module.test.mjs
// NO prueba concurrencia real (PGlite es de una sola conexion): esa prueba se hace en una branch de Supabase.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(dir, '..', '008_inventory_module.sql'), 'utf8');
// PGLITE = ruta absoluta a .../node_modules/@electric-sql/pglite/dist/index.js (o omitir si esta instalado junto al script)
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const R1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const C = 'c0000000-0000-0000-0000-00000000000c';
const NOSTOCK = 'd0000000-0000-0000-0000-00000000000d';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const asRole = async (role, sub, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ role, sub: sub ?? null })}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims','',false);`); }
};
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const stock = async (id) => (await q(`select current_stock s, is_available a, disabled_by_stock d from menu_items where id=$1`, [id]))[0];
const ledger = async (id) => q(`select reason, delta, stock_before, stock_after from inventory_movements where menu_item_id=$1 order by created_at, id`, [id]);
const setStock = async (id, n, avail = true, dis = false) => {
  await db.exec(`select set_config('inventory.internal','on',false)`);
  await q(`update menu_items set current_stock=$2, is_available=$3, disabled_by_stock=$4, stock_reset_date=null where id=$1`, [id, n, avail, dis]);
  await db.exec(`select set_config('inventory.internal','off',false)`);
};
const newOrder = async (items, status = 'PENDIENTE', role = 'service_role', uid = U1) => {
  const id = crypto.randomUUID();
  await asRole(role, uid, () => q(`insert into takeaway_orders(id,user_id,restaurant_id,items,total_amount,status) values($1,$2,$3,$4,1000,$5)`, [id, uid, R1, JSON.stringify(items), status]));
  return id;
};
const setStatus = (id, status, role = 'service_role', uid = U1) => asRole(role, uid, () => q(`update takeaway_orders set status=$2 where id=$1`, [id, status]));

// ---------- esquema stub que replica produccion ----------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
`);
await db.exec(`
  create function auth.uid() returns uuid language sql stable as $$ select (nullif(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'sub','null'))::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role, public;
  grant usage on schema public to anon, authenticated, service_role;
  create table restaurants(id uuid primary key);
  create table menu_items(
    id uuid primary key default gen_random_uuid(), restaurant_id uuid, name text not null, price integer not null default 1,
    is_available boolean default true, stock_managed boolean default false, current_stock integer default 0,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  alter table menu_items enable row level security;
  create policy "viewable" on menu_items for select to public using (true);
  create table takeaway_orders(
    id uuid primary key default gen_random_uuid(), user_id uuid, restaurant_id uuid, items jsonb, total_amount integer,
    status text, approved_at timestamptz, metadata jsonb, updated_at timestamptz,
    constraint takeaway_orders_status_check check (status in ('CREADA','PENDIENTE','APROBADA','RECHAZADA','PREPARANDO','LISTO','ENTREGADO','COMPLETADO','CANCELADO','NO_RETIRADO')));
  alter table takeaway_orders enable row level security;
  create policy "ins" on takeaway_orders for insert to public with check (auth.uid() = user_id);
  create policy "upd" on takeaway_orders for update to public using (auth.uid() = user_id);
  create policy "sel" on takeaway_orders for select to public using (auth.uid() = user_id);
  grant select, insert, update, delete on menu_items, takeaway_orders to anon, authenticated, service_role;
  -- stub del trigger de auto-aprobacion real (BEFORE INSERT): aprueba PENDIENTE si app.auto='on'
  create function auto_approve_takeaway_order() returns trigger language plpgsql as $$
  begin if current_setting('app.auto', true) = 'on' and NEW.status in ('PENDIENTE','CREADA') then NEW.status := 'APROBADA'; NEW.approved_at := now(); end if; return NEW; end $$;
  create trigger tr_auto_approve_takeaway_order before insert on takeaway_orders for each row execute function auto_approve_takeaway_order();
  -- trigger ORIGINAL de produccion (007) como punto de partida, luego se aplica 008 encima
`);
await db.exec(readFileSync(join(dir, '..', '007_takeaway_inventory_trigger_reference.sql'), 'utf8'));
await db.exec(`insert into restaurants values ('${R1}');
  insert into menu_items(id,restaurant_id,name,stock_managed,current_stock,is_available) values
   ('${A}','${R1}','Pastel',true,10,true),('${B}','${R1}','Cazuela',true,5,true),('${C}','${R1}','Ensalada',true,3,true),('${NOSTOCK}','${R1}','Bebida',false,0,true);`);
await db.exec(migration);
await db.exec(`select set_config('app.auto','off',false)`);
ok('migracion 008 aplica sin errores', true);

// ---------- 1. aprobar manual ----------
await setStock(A, 10);
let o = await newOrder([{ id: A, quantity: 3 }, { id: NOSTOCK, quantity: 2 }]);
ok('PENDIENTE no descuenta', (await stock(A)).s === 10);
await setStatus(o, 'APROBADA');
ok('aprobar manual descuenta el total exacto', (await stock(A)).s === 7);
ok('1 fila de ledger ORDER_APPROVED', JSON.stringify(await ledger(A)) === JSON.stringify([{ reason: 'ORDER_APPROVED', delta: -3, stock_before: 10, stock_after: 7 }]));
ok('item sin stock_managed: no se descuenta ni registra', (await ledger(NOSTOCK)).length === 0);
await setStatus(o, 'APROBADA');
ok('repetir APROBADA no duplica (idempotencia)', (await stock(A)).s === 7 && (await ledger(A)).length === 1);

// ---------- 2. auto-aprobacion en INSERT ----------
await db.exec(`select set_config('app.auto','on',false)`);
await setStock(B, 5);
o = await newOrder([{ menu_item_id: B, quantity: 2 }, { menu_item_id: B, quantity: 1 }]);
ok('auto-aprobacion descuenta una sola vez (lineas repetidas agregadas)', (await stock(B)).s === 2 && (await ledger(B)).length === 1);
await db.exec(`select set_config('app.auto','off',false)`);

// ---------- 3. devolucion previa a cocina ----------
await setStatus(o, 'CANCELADO');
ok('APROBADA -> CANCELADO devuelve exactamente lo descontado', (await stock(B)).s === 5);
ok('ledger: ORDER_APPROVED + ORDER_RETURNED', (await ledger(B)).map(r => r.reason).join() === 'ORDER_APPROVED,ORDER_RETURNED');
await setStatus(o, 'CANCELADO');
ok('repetir la devolucion no duplica', (await stock(B)).s === 5 && (await ledger(B)).length === 2);

await setStock(C, 3);
o = await newOrder([{ id: C, quantity: 1 }]); await setStatus(o, 'APROBADA'); await setStatus(o, 'RECHAZADA');
ok('APROBADA -> RECHAZADA devuelve', (await stock(C)).s === 3);

// ---------- 4. consumido: PREPARANDO o posterior no devuelve ----------
for (const last of ['CANCELADO', 'NO_RETIRADO', 'ENTREGADO']) {
  await setStock(C, 3);
  o = await newOrder([{ id: C, quantity: 1 }]); await setStatus(o, 'APROBADA'); await setStatus(o, 'PREPARANDO');
  const before = (await ledger(C)).length;
  await setStatus(o, last);
  ok(`PREPARANDO -> ${last}: no devuelve ni crea fila`, (await stock(C)).s === 2 && (await ledger(C)).length === before);
}
await setStock(C, 3);
o = await newOrder([{ id: C, quantity: 1 }]); await setStatus(o, 'APROBADA'); await setStatus(o, 'PREPARANDO'); await setStatus(o, 'LISTO'); await setStatus(o, 'CANCELADO');
ok('LISTO -> CANCELADO: no devuelve', (await stock(C)).s === 2);
await setStock(C, 3);
o = await newOrder([{ id: C, quantity: 1 }]); await setStatus(o, 'APROBADA'); await setStatus(o, 'PREPARANDO'); await setStatus(o, 'LISTO'); await setStatus(o, 'NO_RETIRADO');
ok('LISTO -> NO_RETIRADO: no devuelve', (await stock(C)).s === 2);

// ---------- 5. agotar / reactivar ----------
await setStock(A, 2);
o = await newOrder([{ id: A, quantity: 2 }]); await setStatus(o, 'APROBADA');
let s = await stock(A);
ok('descuento que deja 0 apaga y marca disabled_by_stock', s.s === 0 && s.a === false && s.d === true);
await setStatus(o, 'RECHAZADA');
s = await stock(A);
ok('devolucion desde 0 repone Y reactiva', s.s === 2 && s.a === true && s.d === false);

await setStock(A, 1);
o = await newOrder([{ id: A, quantity: 1 }]); await setStatus(o, 'APROBADA');
await asRole('service_role', null, () => q(`select inventory_adjust($1,'increase',5,$2)`, [A, U1]));
s = await stock(A);
ok('Aumento manual reactiva un item apagado por el sistema', s.s === 5 && s.a === true && s.d === false);

await setStock(A, 4, false, false); // el admin lo apago a mano con stock > 0
await asRole('service_role', null, () => q(`select inventory_adjust($1,'increase',5,null)`, [A]));
ok('item apagado a mano NO se reactiva con Aumento', (await stock(A)).a === false);

await setStock(A, 0, false, false); // apagado a mano en 0
o = await newOrder([{ id: B, quantity: 1 }]); // irrelevante
await asRole('service_role', null, () => q(`select inventory_set_daily_initial($1,10,null)`, [A]));
s = await stock(A);
ok('stock inicial no reactiva un item apagado a mano', s.s === 10 && s.a === false && s.d === false);

await setStock(A, 3, true, false);
await asRole('service_role', null, () => q(`select inventory_adjust($1,'decrease',3,null)`, [A]));
s = await stock(A);
ok('MANUAL_DECREASE que deja 0 apaga con disabled_by_stock', s.s === 0 && s.a === false && s.d === true);
await asRole('service_role', null, () => q(`select inventory_set_daily_initial($1,8,null)`, [A]));
s = await stock(A);
ok('stock inicial reactiva un item apagado por el sistema', s.s === 8 && s.a === true && s.d === false);

await setStock(A, 0, false, true);
await q(`update menu_items set is_available=true where id=$1`, [A]);
await q(`update menu_items set is_available=false where id=$1`, [A]);
ok('apagar/encender a mano limpia la marca disabled_by_stock', (await stock(A)).d === false);

// ---------- 6. guard de sobreventa ----------
await setStock(A, 2);
const lenA = (await ledger(A)).length;
let e = await fails(() => newOrder([{ id: A, quantity: 3 }]));
ok('INSERT con mas de lo disponible es rechazado con nombre + maximo', e && /SIN_STOCK\|Pastel\|2/.test(e.message), e?.message);
ok('el rechazo no modifica stock ni ledger', (await stock(A)).s === 2 && (await ledger(A)).length === lenA);
await setStock(A, 1);
await db.exec(`select set_config('app.auto','on',false)`);
const o1 = await newOrder([{ id: A, quantity: 1 }]);
e = await fails(() => newOrder([{ id: A, quantity: 1 }]));
ok('segundo pedido por el ultimo stock rechazado (secuencial)', e && /SIN_STOCK/.test(e.message) && (await stock(A)).s === 0);
await db.exec(`select set_config('app.auto','off',false)`);

await setStock(A, 1);
const p1 = await newOrder([{ id: A, quantity: 1 }]); const p2 = await newOrder([{ id: A, quantity: 1 }]);
await setStatus(p1, 'APROBADA');
e = await fails(() => setStatus(p2, 'APROBADA'));
ok('aprobacion manual sin stock falla con SIN_STOCK, sin recorte', e && /SIN_STOCK\|Pastel\|0/.test(e.message) && (await stock(A)).s === 0);
ok('el pedido que fallo sigue PENDIENTE', (await q(`select status from takeaway_orders where id=$1`, [p2]))[0].status === 'PENDIENTE');

// ---------- 7. ajustes manuales y stock inicial ----------
await setStock(A, 3);
const lenA2 = (await ledger(A)).length;
let r = (await asRole('service_role', null, () => q(`select inventory_adjust($1,'decrease',5,null) r`, [A])))[0].r;
ok('Disminucion mayor al stock rechazada, sin ledger', r.success === false && (await stock(A)).s === 3 && (await ledger(A)).length === lenA2);
r = (await asRole('service_role', null, () => q(`select inventory_adjust($1,'increase',7,$2) r`, [A, U1])))[0].r;
ok('Aumento sin limite + ledger con actor', r.success && (await stock(A)).s === 10 && (await q(`select actor_id from inventory_movements where menu_item_id=$1`, [A]))[0].actor_id === U1);
await setStock(B, 4);
r = (await asRole('service_role', null, () => q(`select inventory_set_daily_initial($1,20,null) r`, [B])))[0].r;
ok('stock inicial: current = inicial, fecha = hoy, en ledger', r.success && (await stock(B)).s === 20 && (await ledger(B)).some(x => x.reason === 'DAILY_INITIAL' && x.delta === 16));
r = (await asRole('service_role', null, () => q(`select inventory_set_daily_initial($1,30,null) r`, [B])))[0].r;
ok('segunda carga el mismo dia rechazada', r.success === false && (await stock(B)).s === 20);
await db.exec(`select set_config('inventory.internal','on',false)`); await q(`update menu_items set stock_reset_date=current_date-1 where id=$1`, [B]); await db.exec(`select set_config('inventory.internal','off',false)`);
r = (await asRole('service_role', null, () => q(`select inventory_set_daily_initial($1,30,null) r`, [B])))[0].r;
ok('al dia siguiente se permite de nuevo', r.success === true && (await stock(B)).s === 30);

// ---------- 8. invariantes ----------
ok('todo el ledger cumple stock_after = stock_before + delta', (await q(`select count(*)::int c from inventory_movements where stock_after <> stock_before + delta`))[0].c === 0);
e = await fails(() => q(`update menu_items set current_stock=99 where id=$1`, [A]));
ok('UPDATE directo de current_stock bloqueado (INV02)', e && /inventario/.test(e.message));
e = await fails(() => q(`update inventory_movements set delta=0`));
ok('ledger inmutable (UPDATE)', !!e);
e = await fails(() => q(`delete from inventory_movements`));
ok('ledger inmutable (DELETE)', !!e);
e = await fails(() => q(`truncate inventory_movements`));
ok('ledger inmutable (TRUNCATE)', !!e);

// ---------- 9. seguridad: cliente ----------
e = await fails(() => newOrder([{ id: A, quantity: 1 }], 'APROBADA', 'authenticated', U1));
ok('cliente no puede insertar un pedido ya APROBADA', e && /INV03/.test(e.code ?? '') || (e && /Estado inicial/.test(e.message)), e?.message);
await setStock(A, 10);
o = await newOrder([{ id: A, quantity: 1 }], 'PENDIENTE', 'authenticated', U1);
ok('cliente puede crear un pedido PENDIENTE', !!o);
e = await fails(() => setStatus(o, 'APROBADA', 'authenticated', U1));
ok('cliente no puede auto-aprobar su pedido', e && /Transicion no permitida/.test(e.message));
e = await fails(() => asRole('authenticated', U1, () => q(`update takeaway_orders set items='[]'::jsonb where id=$1`, [o])));
ok('cliente no puede cambiar items', e && /no puede modificar/.test(e.message));
e = await fails(() => asRole('authenticated', U1, () => q(`update takeaway_orders set total_amount=1 where id=$1`, [o])));
ok('cliente no puede cambiar total', !!e);
await setStatus(o, 'CANCELADO', 'authenticated', U1);
ok('cliente puede cancelar su pedido PENDIENTE', (await q(`select status from takeaway_orders where id=$1`, [o]))[0].status === 'CANCELADO');
await setStock(A, 10);
o = await newOrder([{ id: A, quantity: 2 }]); await setStatus(o, 'APROBADA');
await setStatus(o, 'CANCELADO', 'authenticated', U1);
ok('cliente cancela APROBADA (antes de cocina): devuelve stock', (await stock(A)).s === 10);
o = await newOrder([{ id: A, quantity: 1 }]); await setStatus(o, 'APROBADA'); await setStatus(o, 'PREPARANDO'); await setStatus(o, 'LISTO');
await setStatus(o, 'ENTREGADO', 'authenticated', U1);
ok('cliente notifica retiro LISTO -> ENTREGADO (flujo PWA existente)', (await q(`select status from takeaway_orders where id=$1`, [o]))[0].status === 'ENTREGADO');
e = await fails(() => asRole('anon', null, () => q(`select inventory_adjust($1,'increase',5,null)`, [A])));
ok('anon no puede ejecutar inventory_adjust', !!e);
e = await fails(() => asRole('authenticated', U1, () => q(`select inventory_move($1,5,'MANUAL_INCREASE')`, [A])));
ok('authenticated no puede ejecutar inventory_move', !!e);
e = await fails(() => asRole('authenticated', U1, () => q(`select * from inventory_movements`)));
ok('authenticated no puede leer el ledger', !!e);
r = (await asRole('anon', null, () => q(`select inventory_check_availability($1::jsonb) r`, [JSON.stringify([{ id: A, quantity: 999 }])])))[0].r;
ok('check_availability informa faltantes con maximo disponible', r.length === 1 && r[0].name === 'Pastel' && r[0].available === (await stock(A)).s);

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
