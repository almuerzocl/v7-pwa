// Pruebas de 051_contact_identities.sql sobre PGlite (Postgres en WASM, un solo proceso).
// Uso:  PGLITE=<node_modules>/@electric-sql/pglite/dist/index.js node migrations/tests/051_contact_identities.test.mjs   (Node >= 22.18)
// No prueba concurrencia real ni los grants automáticos de Supabase a service_role: tras aplicar hay que verificar
// role_table_grants y proacl en la base real, y el dry-run contra los triggers reales de reservations.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const m051 = readFileSync(join(dir, '..', '051_contact_identities.sql'), 'utf8');
const { PGlite } = await import(process.env.PGLITE ?? '@electric-sql/pglite');
const db = new PGlite();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e; } };
const asRole = async (role, fn) => { await db.exec(`SET ROLE ${role}`); try { return await fn(); } finally { await db.exec('RESET ROLE'); } };
const claim = (role) => db.query(`select set_config('request.jwt.claims', $1, false)`, [role ? JSON.stringify({ role }) : '']);

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = U(1), ORG2 = U(2), USR = U(3);
const G1 = U(11), G2 = U(12), G3 = U(13), GORG = U(10);

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table profiles (id uuid primary key, email text);
  create table reservations (id uuid primary key default gen_random_uuid(), organizer_id uuid references profiles(id), status text not null,
    date_time timestamptz, guest_data jsonb not null default '[]'::jsonb);
  create table contacts (id uuid primary key default gen_random_uuid(), owner_id uuid references profiles(id) on delete cascade, first_name text, last_name text,
    email text, whatsapp_phone text, avatar_url text, created_at timestamptz not null default now());
  grant all on contacts, profiles, reservations to authenticated;
  create function inventory_caller_role() returns text language sql stable set search_path to 'public' as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', nullif(current_setting('request.jwt.claim.role', true), '')) $$;
`);
await db.exec(m051);
await db.exec(m051); // re-ejecutable
ok('la migración se puede ejecutar dos veces', true);

await db.query(`insert into profiles values ($1,'esteban@x.cl'),($2,'otro@x.cl'),($3,'ana.registrada@gmail.com')`, [ORG, ORG2, USR]);
const guests = (extra = []) => JSON.stringify([
  { id: GORG, name: 'Esteban Zárate', is_organizer: true, status: 'CONFIRMADA', email: 'esteban@x.cl' },
  { id: G1, name: 'Camila Soto Rojas', email: 'camila@x.cl', status: 'PENDIENTE' },
  { id: G2, name: 'Pedro Rojas', email: null, status: 'CONFIRMADA' },
  ...extra,
]);
const mkRes = async (status = 'CONFIRMADA', organizer = ORG, g = guests()) =>
  (await one(`insert into reservations (organizer_id, status, date_time, guest_data) values ($1,$2,now() + interval '2 days',$3) returning id`, [organizer, status, g])).id;
const reg = async (res, guest, email, version = 'v1', scope = null) =>
  (await one(`select register_guest_contact($1,$2,$3,$4,${scope ? '$5::text[]' : "ARRAY['avisos_reserva','futuras_invitaciones']"}) as r`, scope ? [res, guest, email, version, scope] : [res, guest, email, version])).r;
const guestOf = async (res, id) => (await one(`select e from reservations, jsonb_array_elements(guest_data) e where reservations.id = $1 and e->>'id' = $2`, [res, id])).e;

// ───── permisos ─────
const tables = ['contact_identities', 'contact_consents', 'contact_identity_blocks'];
for (const t of tables) {
  ok(`${t}: RLS activa`, (await one(`select relrowsecurity as r from pg_class where oid = 'public.${t}'::regclass`)).r === true);
  const g = await q(`select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name=$1`, [t]);
  ok(`${t}: ni anon ni authenticated tienen permisos`, !g.some((x) => ['anon', 'authenticated', 'PUBLIC'].includes(x.grantee)), JSON.stringify(g));
  ok(`${t}: service_role sin TRUNCATE, REFERENCES ni TRIGGER`, !g.some((x) => x.grantee === 'service_role' && ['TRUNCATE', 'REFERENCES', 'TRIGGER'].includes(x.privilege_type)));
}
const gc = await q(`select privilege_type from information_schema.role_table_grants where table_name='contact_consents' and grantee='service_role'`);
ok('contact_consents: el consentimiento no se edita (sin UPDATE)', !gc.some((x) => x.privilege_type === 'UPDATE') && gc.some((x) => x.privilege_type === 'INSERT'));
ok('authenticated no puede leer contact_identities', (await asRole('authenticated', () => err('select * from contact_identities')))?.message.includes('permission denied'));
ok('anon no puede leer contact_consents', (await asRole('anon', () => err('select * from contact_consents')))?.message.includes('permission denied'));
for (const f of ['register_guest_contact(uuid,text,text,text,text[])', 'resolve_identity_email(uuid,uuid)', 'contact_invite_status(uuid)', 'contact_identity_unsubscribe(uuid,text,uuid)', 'erase_contact_identity(uuid)', 'erase_contact_identity_by_email(text)']) {
  const acl = (await one(`select proacl::text as a from pg_proc where oid = 'public.${f}'::regprocedure`)).a ?? '';
  ok(`${f.split('(')[0]}: solo service_role puede ejecutarla`, acl.includes('service_role=X') && !acl.includes('anon') && !acl.includes('authenticated') && !/(^\{|,)=X/.test(acl), acl);
}

// ───── registrar: camino feliz con correo escrito ─────
// En el wizard el id del invitado ES el id del contacto de la agenda.
await db.query(`insert into contacts (id, owner_id, first_name, last_name, email) values ($1,$2,'Pedro','Rojas',NULL)`, [G2, ORG]);
let res = await mkRes();
let r = await reg(res, G2, '  Pedro.Rojas@GMAIL.com ');
ok('registra: success y devuelve ids, nunca el correo', r.success === true && r.identity_id && r.contact_id && !JSON.stringify(r).toLowerCase().includes('pedro.rojas'), JSON.stringify(r));
const idn = await one(`select * from contact_identities where id = $1`, [r.identity_id]);
ok('la identidad guarda el correo normalizado', idn.email_norm === 'pedro.rojas@gmail.com' && idn.status === 'active');
const g2 = await guestOf(res, G2);
ok('el invitado queda con identity_id y fecha de consentimiento', g2.identity_id === r.identity_id && !!g2.notify_consent_at && g2.notify_consent_version === 'v1');
ok('el correo NO está en guest_data de ninguna reserva', (await q(`select 1 from reservations where guest_data::text ilike '%pedro.rojas%'`)).length === 0);
ok('no se creó una columna notify_email', g2.notify_email === undefined);
ok('los demás invitados no cambian', JSON.stringify(await guestOf(res, G1)) === JSON.stringify({ id: G1, name: 'Camila Soto Rojas', email: 'camila@x.cl', status: 'PENDIENTE' }));
const order = (await one(`select jsonb_agg(e->>'id') as ids from reservations, jsonb_array_elements(guest_data) e where reservations.id = $1`, [res])).ids;
ok('el orden de los invitados se conserva', JSON.stringify(order) === JSON.stringify([GORG, G1, G2]));
const cons = await one(`select * from contact_consents where identity_id = $1`, [r.identity_id]);
ok('queda el registro del consentimiento (quién, dónde, alcance y versión)', cons.organizer_id === ORG && cons.reservation_id === res && cons.guest_id === G2 && cons.version === 'v1' && cons.scope.length === 2);

// ───── contacto del organizador ─────
ok('si el invitado ES un contacto (mismo id), se vincula sin duplicar', r.contact_id === G2 && r.contact_created === false);
const linked = await one(`select identity_id, email from contacts where id = $1`, [G2]);
ok('el contacto queda apuntando a la identidad y sin correo', linked.identity_id === r.identity_id && linked.email === null);
res = await mkRes();
r = await reg(res, G2, 'pedro.rojas@gmail.com');
ok('registrar otra vez el mismo contacto es idempotente (mismo contacto, sin duplicar)', r.contact_id === G2 && r.contact_created === false && (await one(`select count(*)::int as n from contacts where owner_id = $1 and identity_id = $2`, [ORG, r.identity_id])).n === 1);
ok('un mismo correo no duplica identidades', (await one(`select count(*)::int as n from contact_identities where email_norm = 'pedro.rojas@gmail.com'`)).n === 1);

res = await mkRes('CONFIRMADA', ORG, guests([{ id: G3, name: 'Luis Paz Mora', email: null, status: 'PENDIENTE' }]));
r = await reg(res, G3, 'luis@x.cl');
const lc = await one(`select * from contacts where id = $1`, [r.contact_id]);
ok('sin contacto previo se crea uno nuevo, con nombre separado y SIN correo', r.contact_created === true && lc.first_name === 'Luis' && lc.last_name === 'Paz Mora' && lc.email === null && lc.owner_id === ORG);
const again = await reg(await mkRes('CONFIRMADA', ORG, guests([{ id: U(14), name: 'Luis P.', email: null }])), U(14), 'LUIS@x.cl');
ok('el mismo correo en otra reserva del organizador reutiliza su contacto', again.contact_id === r.contact_id && again.contact_created === false);
ok('el organizador tiene un solo contacto por identidad', (await one(`select count(*)::int as n from contacts where owner_id = $1 and identity_id = $2`, [ORG, r.identity_id])).n === 1);

await db.query(`insert into contacts (owner_id, first_name, email) values ($1,'Marta','marta@x.cl')`, [ORG]);
res = await mkRes('CONFIRMADA', ORG, guests([{ id: U(15), name: 'Marta G', email: 'marta@x.cl' }]));
r = await reg(res, U(15), null);
const mc = await one(`select * from contacts where id = $1`, [r.contact_id]);
ok('sin correo escrito usa el de la invitación y enlaza el contacto que ya tenía ese correo', r.success && mc.first_name === 'Marta' && mc.email === 'marta@x.cl' && mc.identity_id === r.identity_id, JSON.stringify(r));

res = await mkRes('CONFIRMADA', ORG2, guests([{ id: U(16), name: 'Pedro R', email: null }]));
const r2 = await reg(res, U(16), 'pedro.rojas@gmail.com');
ok('otro organizador comparte la identidad pero tiene su propio contacto', r2.identity_id === idn.id && r2.contact_id !== G2 && (await one(`select owner_id from contacts where id = $1`, [r2.contact_id])).owner_id === ORG2);

// ───── cuenta existente ─────
res = await mkRes('CONFIRMADA', ORG, guests([{ id: U(17), name: 'Ana', email: null }]));
r = await reg(res, U(17), 'Ana.Registrada@gmail.com');
const anaId = r.identity_id;
ok('detecta que tiene cuenta por el correo que ella entregó', r.has_account === true && (await one(`select user_id from contact_identities where id = $1`, [r.identity_id])).user_id === USR);

// ───── rechazos: no se escribe nada ─────
const before = JSON.stringify(await q(`select (select count(*) from contact_identities) a, (select count(*) from contact_consents) b, (select count(*) from contacts) c`));
const cases = [
  ['PENDIENTE', G1, 'a@b.cl', 'not_confirmed'], ['CANCELADA', G1, 'a@b.cl', 'closed'], ['RECHAZADA', G1, 'a@b.cl', 'closed'],
  ['CONFIRMADA', GORG, 'a@b.cl', 'organizer'], ['CONFIRMADA', U(99), 'a@b.cl', 'guest_not_found'],
  ['CONFIRMADA', G1, 'no-es-correo', 'invalid_email'], ['CONFIRMADA', G1, 'a b@c.cl', 'invalid_email'], ['CONFIRMADA', G1, 'a@b', 'invalid_email'],
];
for (const [st, gid, em, code] of cases) {
  const x = await reg(await mkRes(st), gid, em);
  ok(`rechaza (${st}, ${gid === GORG ? 'organizador' : gid === U(99) ? 'invitado inexistente' : em}) con ${code}`, x.success === false && x.code === code, JSON.stringify(x));
}
ok('rechaza sin versión y con alcance inválido', (await reg(await mkRes(), G1, 'a@b.cl', '')).code === 'invalid_version'
  && (await reg(await mkRes(), G1, 'a@b.cl', 'v1', ['spam'])).code === 'invalid_scope');
ok('reserva inexistente', (await one(`select register_guest_contact($1,$2,'a@b.cl','v1') as r`, [U(777), G1])).r.code === 'not_found');
ok('un invitado sin correo en la invitación ni escrito: pide correo', (await reg(await mkRes(), G2, null)).code === 'email_required');
ok('los rechazos no escribieron nada', JSON.stringify(await q(`select (select count(*) from contact_identities) a, (select count(*) from contact_consents) b, (select count(*) from contacts) c`)) === before);

// ───── baja y bloqueo ─────
const idP = idn.id;
ok('resolve_identity_email entrega el correo si está activa', (await one(`select resolve_identity_email($1,$2) as e`, [idP, ORG])).e === 'pedro.rojas@gmail.com');
ok('contact_invite_status: contacto con identidad activa recibe invitaciones, sin mostrar correo', (await q(`select * from contact_invite_status($1)`, [ORG])).find((x) => x.contact_id === G2).receives_invites === true);
await db.query(`select contact_identity_unsubscribe($1,'organizer',$2)`, [idP, ORG]);
await db.query(`select contact_identity_unsubscribe($1,'organizer',$2)`, [idP, ORG]);
ok('bloquear a un organizador es idempotente', (await one(`select count(*)::int as n from contact_identity_blocks where identity_id = $1`, [idP])).n === 1);
ok('bloqueado por ORG: no se resuelve su correo para ORG', (await one(`select resolve_identity_email($1,$2) as e`, [idP, ORG])).e === null);
ok('…pero sí para otro organizador', (await one(`select resolve_identity_email($1,$2) as e`, [idP, ORG2])).e === 'pedro.rojas@gmail.com');
ok('contact_invite_status: bloqueado = no recibe', (await q(`select * from contact_invite_status($1)`, [ORG])).find((x) => x.contact_id === G2).receives_invites === false);
res = await mkRes('CONFIRMADA', ORG, guests([{ id: U(18), name: 'Pedro de nuevo', email: null }]));
r = await reg(res, U(18), 'pedro.rojas@gmail.com');
ok('si bloqueó al organizador, el consentimiento se registra pero NO entra a su agenda', r.success && r.blocked === true && r.contact_id === null);
await db.query(`select contact_identity_unsubscribe($1,'all',NULL)`, [idP]);
ok('baja total: ya no se resuelve para nadie', (await one(`select resolve_identity_email($1,$2) as e`, [idP, ORG2])).e === null);
ok('baja con alcance inválido o identidad inexistente se rechaza', (await one(`select contact_identity_unsubscribe($1,'x',NULL) as r`, [idP])).r.code === 'invalid_scope'
  && (await one(`select contact_identity_unsubscribe($1,'all',NULL) as r`, [U(555)])).r.code === 'not_found');
res = await mkRes('CONFIRMADA', ORG2, guests([{ id: U(19), name: 'Pedro otra vez', email: null }]));
r = await reg(res, U(19), 'pedro.rojas@gmail.com');
ok('un nuevo consentimiento explícito reactiva la baja', r.success && (await one(`select status from contact_identities where id = $1`, [idP])).status === 'active');
await db.query(`update contact_identities set status = 'bounced' where id = $1`, [idP]);
ok('rebotada: no se resuelve y el contacto no recibe', (await one(`select resolve_identity_email($1,$2) as e`, [idP, ORG2])).e === null
  && (await q(`select * from contact_invite_status($1)`, [ORG2])).find((x) => x.contact_id === r.contact_id).receives_invites === false);

// ───── contact_invite_status: contacto con correo propio y contacto vacío ─────
await db.query(`insert into contacts (id, owner_id, first_name, email) values ($1,$2,'Propio','propio@x.cl'),($3,$2,'Vacío',NULL)`, [U(30), ORG2, U(31)]);
const st = await q(`select * from contact_invite_status($1)`, [ORG2]);
ok('contacto con correo propio recibe invitaciones; contacto sin nada no', st.find((x) => x.contact_id === U(30)).receives_invites === true && st.find((x) => x.contact_id === U(31)).receives_invites === false);
ok('has_account solo aparece donde el invitado entregó su correo', st.find((x) => x.contact_id === U(30)).has_account === false);

// ───── el cliente no puede fijar identity_id ─────
await claim('authenticated');
const insBad = await err(`insert into contacts (owner_id, first_name, identity_id) values ($1,'X',$2)`, [ORG, idP]);
ok('authenticated no puede crear un contacto con identity_id', insBad?.hint === 'identity_forbidden', insBad?.message);
const upBad = await err(`update contacts set identity_id = $1 where id = $2`, [idP, U(30)]);
ok('authenticated no puede cambiar identity_id', upBad?.hint === 'identity_forbidden', upBad?.message);
const upOk = await err(`update contacts set first_name = 'Propio 2' where id = $1`, [U(30)]);
ok('authenticated sí puede editar el resto de su contacto', upOk === null, upOk?.message);
const upKeep = await err(`update contacts set first_name = 'Pedro R.' where id = $1`, [G2]);
ok('y editar un contacto ya vinculado, sin tocar identity_id', upKeep === null, upKeep?.message);
await claim('anon');
ok('anon tampoco', (await err(`insert into contacts (owner_id, first_name, identity_id) values ($1,'X',$2)`, [ORG, idP]))?.hint === 'identity_forbidden');
await claim('service_role');
ok('service_role sí puede (así lo hace la función)', (await err(`update contacts set identity_id = $1 where id = $2`, [anaId, U(30)])) === null);
await claim(null);
await db.query(`update contacts set identity_id = NULL where id = $1`, [U(30)]);

// ───── borrar (derecho a supresión) ─────
res = await mkRes('CONFIRMADA', ORG, guests([{ id: U(20), name: 'Borrar Yo', email: null }]));
r = await reg(res, U(20), 'borrame@x.cl');
const res2 = await mkRes('CONFIRMADA', ORG2, guests([{ id: U(21), name: 'Borrar Yo', email: null }]));
await reg(res2, U(21), 'borrame@x.cl');
const ex = (await one(`select erase_contact_identity_by_email(' BORRAME@x.cl ') as r`)).r;
ok('borrar por correo: limpia las 2 reservas y elimina la identidad', ex.success && ex.reservations_cleaned === 2 && ex.identity_deleted === true, JSON.stringify(ex));
ok('no queda rastro del correo en ninguna tabla', (await q(`select 1 from contact_identities where email_norm like 'borrame%' union all select 1 from reservations where guest_data::text ilike '%borrame%'`)).length === 0);
const gAfter = await guestOf(res, U(20));
ok('el invitado queda sin marcas de identidad y conserva su respuesta y nombre', gAfter.identity_id === undefined && gAfter.notify_consent_at === undefined && gAfter.name === 'Borrar Yo');
ok('los contactos sueltan el vínculo pero siguen existiendo', (await q(`select 1 from contacts where id = $1 and identity_id is null`, [r.contact_id])).length === 1);
ok('los consentimientos de esa identidad se borran', (await one(`select count(*)::int as n from contact_consents where identity_id = $1`, [r.identity_id])).n === 0);
ok('borrar un correo que no existe no falla', (await one(`select erase_contact_identity_by_email('nadie@x.cl') as r`)).r.success === true);
ok('otras identidades no se tocan', (await one(`select count(*)::int as n from contact_identities where email_norm = 'pedro.rojas@gmail.com'`)).n === 1);

console.log(`\n${pass} pasan, ${fail} fallan`);
process.exit(fail ? 1 : 0);
