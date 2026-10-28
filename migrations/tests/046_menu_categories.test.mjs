// Pruebas de 046_menu_categories.sql sobre PGlite (Postgres en WASM, un solo proceso).
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node migrations/tests/046_menu_categories.test.mjs
// No prueba concurrencia real ni los grants automáticos de Supabase: tras aplicar hay que verificar role_table_grants / proacl en la base real.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(dir, '..', '046_menu_categories.sql'), 'utf8');
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const fails = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return String(e.message); } };

const R1 = '11111111-1111-1111-1111-111111111111';
const R2 = '22222222-2222-2222-2222-222222222222';

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table restaurants (id uuid primary key, name text);
  create table menu_items (
    id uuid primary key default gen_random_uuid(), restaurant_id uuid references restaurants(id), name text not null,
    category text not null default 'General', created_at timestamptz not null default now(), is_menu_del_dia boolean default false);
`);
await db.query(`insert into restaurants values ($1,'Cri-Olla'),($2,'Otro')`, [R1, R2]);
// Datos REALES de Cri-Olla (2026-10-27) + variantes de grafía y un restaurante sin platos de esa categoría.
const seed = [
  ['Acompáñamientos', 'Arroz'], ['Acompáñamientos', 'Papas'], ['Acompáñamientos', 'Ensalada'], ['Acompáñamientos', 'Puré'],
  ['Manú Económico', 'Económico'], ['Menú Especial', 'Pastel'], ['Menú Especial', 'Cazuela'], ['Menúy Especial', 'Porotos'],
  ['acompañamientos ', 'Pan'], ['  Menú   Especial', 'Humita'],
];
for (const [c, n] of seed) await db.query(`insert into menu_items (restaurant_id, name, category) values ($1,$2,$3)`, [R1, n, c]);
await db.query(`insert into menu_items (restaurant_id, name, category) values ($1,'Sopa','Acompáñamientos')`, [R2]);

await db.exec(migration);

// ---- backfill ----
const cats = await q(`select name, position from menu_categories where restaurant_id=$1 order by position`, [R1]);
ok('backfill: 3 variantes de grafía colapsan (4 categorías, no 6)', cats.length === 4, JSON.stringify(cats));
ok('backfill: se conserva la grafía más usada', cats.some((c) => c.name === 'Acompáñamientos') && cats.some((c) => c.name === 'Menú Especial'));
ok('backfill: el typo real NO se fusiona', cats.some((c) => c.name === 'Menúy Especial'));
ok('backfill: posiciones 0..n-1 sin huecos', cats.map((c) => c.position).join() === '0,1,2,3');
ok('backfill: ningún plato sin category_id', (await q(`select count(*)::int n from menu_items where category_id is null`))[0].n === 0);
ok('backfill: texto sincronizado con la categoría', (await q(`select count(*)::int n from menu_items i join menu_categories c on c.id=i.category_id where i.category<>c.name`))[0].n === 0);
ok('backfill: el otro restaurante tiene su propia categoría', (await q(`select count(*)::int n from menu_categories where restaurant_id=$1`, [R2]))[0].n === 1);
const posAcc = (await q(`select i.position from menu_items i join menu_categories c on c.id=i.category_id where c.restaurant_id=$1 and c.name='Acompáñamientos' order by position`, [R1])).map((r) => r.position);
ok('backfill: posiciones de platos 0..n-1 por categoría', posAcc.join() === '0,1,2,3,4', posAcc.join());

// ---- normalización ----
ok('norm: tildes, ñ, mayúsculas y espacios', (await q(`select menu_category_norm('  ÁCOMPAÑAMIENTOS  Ñoño ') v`))[0].v === 'acompanamientos nono');
ok('único por restaurante+norm', /duplicate key/i.test(await fails(`insert into menu_categories (restaurant_id,name) values ($1,'acompanamientos')`, [R1]) ?? ''));
ok('nombre vacío rechazado', (await fails(`insert into menu_categories (restaurant_id,name) values ($1,'   ')`, [R1])) !== null);
ok('nombre de 61 caracteres rechazado', (await fails(`insert into menu_categories (restaurant_id,name) values ($1,$2)`, [R1, 'x'.repeat(61)])) !== null);
ok('misma categoría en otro restaurante permitida', (await fails(`insert into menu_categories (restaurant_id,name) values ($1,'Menú Especial')`, [R2])) === null);

// ---- trigger de sincronía ----
const catId = async (name, r = R1) => (await q(`select id from menu_categories where restaurant_id=$1 and name=$2`, [r, name]))[0].id;
await db.query(`insert into menu_items (restaurant_id, name, category) values ($1,'Nuevo','Postres Caseros')`, [R1]);
const created = (await q(`select c.name, c.position, i.position ip from menu_items i join menu_categories c on c.id=i.category_id where i.name='Nuevo'`))[0];
ok('código antiguo (solo texto) crea la categoría al final', created.name === 'Postres Caseros' && created.position === 4 && created.ip === 0, JSON.stringify(created));
await db.query(`insert into menu_items (restaurant_id, name, category) values ($1,'Nuevo2','postres  caseros')`, [R1]);
ok('texto con otra grafía reutiliza la categoría', (await q(`select count(*)::int n from menu_categories where restaurant_id=$1`, [R1]))[0].n === 5);
ok('plato nuevo queda al final de su categoría', (await q(`select position from menu_items where name='Nuevo2'`))[0].position === 1);

await db.query(`insert into menu_items (restaurant_id, name, category_id) values ($1,'ConId',$2)`, [R1, await catId('Menú Especial')]);
ok('alta con category_id copia el nombre al texto', (await q(`select category from menu_items where name='ConId'`))[0].category === 'Menú Especial');
ok('category_id de otro restaurante rechazado', /no pertenece/.test(await fails(`insert into menu_items (restaurant_id, name, category_id) values ($1,'X',$2)`, [R1, await catId('Menú Especial', R2)]) ?? ''));

await db.query(`update menu_items set category_id=$1 where name='Arroz'`, [await catId('Menú Especial')]);
const moved = (await q(`select category, position from menu_items where name='Arroz'`))[0];
ok('mover por category_id actualiza el texto y manda al final', moved.category === 'Menú Especial' && moved.position > 0, JSON.stringify(moved));
await db.query(`update menu_items set category='Acompáñamientos' where name='Arroz'`);
ok('cambiar solo el texto (código antiguo) mueve de categoría', (await q(`select c.name from menu_items i join menu_categories c on c.id=i.category_id where i.name='Arroz'`))[0].name === 'Acompáñamientos');
const beforeEdit = (await q(`select category_id, position from menu_items where name='Arroz'`))[0];
await db.query(`update menu_items set is_menu_del_dia=true where name='Arroz'`);
const afterEdit = (await q(`select category_id, position from menu_items where name='Arroz'`))[0];
ok('editar otra columna no toca categoría ni posición', JSON.stringify(beforeEdit) === JSON.stringify(afterEdit));

// ---- renombrar ----
await db.query(`update menu_categories set name='Guarniciones' where id=$1`, [await catId('Acompáñamientos')]);
ok('renombrar actualiza el texto de los platos', (await q(`select count(*)::int n from menu_items i join menu_categories c on c.id=i.category_id where c.name='Guarniciones' and i.category='Guarniciones'`))[0].n >= 4);
ok('renombrar a un nombre existente falla', (await fails(`update menu_categories set name='menu especial' where name='Guarniciones'`)) !== null);

// ---- reordenar ----
const order = async () => (await q(`select name from menu_categories where restaurant_id=$1 order by position`, [R1])).map((r) => r.name);
const ids = (await q(`select id from menu_categories where restaurant_id=$1 order by position`, [R1])).map((r) => r.id);
const rev = [...ids].reverse();
const before = await order();
await db.query(`select menu_reorder_categories($1, $2::uuid[])`, [R1, rev]);
ok('reordenar categorías aplica el nuevo orden', (await order()).join() === [...before].reverse().join());
ok('reordenar con un id de menos falla', /cambiaron/.test(await fails(`select menu_reorder_categories($1, $2::uuid[])`, [R1, ids.slice(1)]) ?? ''));
ok('reordenar con ids repetidos falla', (await fails(`select menu_reorder_categories($1, $2::uuid[])`, [R1, [ids[0], ids[0], ...ids.slice(2)]])) !== null);
ok('reordenar con categoría de otro restaurante falla', (await fails(`select menu_reorder_categories($1, $2::uuid[])`, [R1, [...ids.slice(1), await catId('Menú Especial', R2)]])) !== null);
ok('reordenar no cruza restaurantes', (await q(`select position from menu_categories where restaurant_id=$1`, [R2])).every((r) => r.position <= 1));

const g = await catId('Guarniciones');
const itemIds = (await q(`select id from menu_items where category_id=$1 order by position`, [g])).map((r) => r.id);
await db.query(`select menu_reorder_items($1, $2::uuid[])`, [g, [...itemIds].reverse()]);
ok('reordenar platos aplica el orden', (await q(`select id from menu_items where category_id=$1 order by position`, [g])).map((r) => r.id).join() === [...itemIds].reverse().join());
ok('reordenar platos con ids de otra categoría falla', (await fails(`select menu_reorder_items($1, $2::uuid[])`, [g, [...itemIds.slice(1), (await q(`select id from menu_items where category_id<>$1 limit 1`, [g]))[0].id]])) !== null);

// ---- eliminar ----
const post = await catId('Postres Caseros');
ok('eliminar con platos sin destino falla', /elige a qué categoría/.test(await fails(`select menu_delete_category($1)`, [post]) ?? ''));
ok('eliminar con destino de otro restaurante falla', (await fails(`select menu_delete_category($1,$2)`, [post, await catId('Menú Especial', R2)])) !== null);
ok('eliminar a sí misma como destino falla', (await fails(`select menu_delete_category($1,$1)`, [post])) !== null);
ok('DELETE directo con platos lo frena la FK (RESTRICT)', (await fails(`delete from menu_categories where id=$1`, [post])) !== null);
await db.query(`select menu_delete_category($1,$2)`, [post, g]);
ok('eliminar moviendo: los platos pasan al destino', (await q(`select count(*)::int n from menu_items i where i.name in ('Nuevo','Nuevo2') and i.category_id=$1 and i.category='Guarniciones'`, [g]))[0].n === 2);
ok('eliminar moviendo: la categoría desaparece', (await q(`select count(*)::int n from menu_categories where id=$1`, [post]))[0].n === 0);
await db.query(`insert into menu_categories (restaurant_id,name) values ($1,'Vacía')`, [R1]);
await db.query(`select menu_delete_category($1)`, [await catId('Vacía')]);
ok('eliminar categoría vacía sin destino', (await q(`select count(*)::int n from menu_categories where name='Vacía'`))[0].n === 0);

// ---- permisos ----
const priv = async (role, table, p) => (await q(`select has_table_privilege($1,$2,$3) v`, [role, table, p]))[0].v;
ok('anon/authenticated: solo SELECT en menu_categories', await priv('anon', 'menu_categories', 'SELECT') && await priv('authenticated', 'menu_categories', 'SELECT')
  && !(await priv('anon', 'menu_categories', 'INSERT')) && !(await priv('authenticated', 'menu_categories', 'UPDATE')) && !(await priv('authenticated', 'menu_categories', 'DELETE')));
ok('service_role: CRUD sin TRUNCATE/REFERENCES/TRIGGER', await priv('service_role', 'menu_categories', 'INSERT') && await priv('service_role', 'menu_categories', 'DELETE')
  && !(await priv('service_role', 'menu_categories', 'TRUNCATE')) && !(await priv('service_role', 'menu_categories', 'TRIGGER')));
const fx = async (role, fn) => (await q(`select has_function_privilege($1,$2,'EXECUTE') v`, [role, fn]))[0].v;
const FNS = ['menu_reorder_categories(uuid,uuid[])', 'menu_reorder_items(uuid,uuid[])', 'menu_delete_category(uuid,uuid)'];
ok('RPC: solo service_role ejecuta', (await Promise.all(FNS.map(async (f) => !(await fx('anon', f)) && !(await fx('authenticated', f)) && (await fx('service_role', f))))).every(Boolean));
ok('RLS activa con una política SELECT', (await q(`select relrowsecurity v from pg_class where relname='menu_categories'`))[0].v === true && (await q(`select count(*)::int n from pg_policies where tablename='menu_categories'`))[0].n === 1);

console.log(`\n${pass} pasan, ${fail} fallan`);
process.exit(fail ? 1 : 0);
