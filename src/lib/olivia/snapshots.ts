// Copias diarias de OlivIA (migración 043, tabla olivia_snapshots): oferta de comida, ficha física de los locales y pronóstico.
// Se construyen una vez al día (cron antes de las 11:00) y se reutilizan toda la ventana de almuerzo. Si la copia no existe, está
// marcada `stale` (un plato se agotó, un local cambió su ficha) o el pronóstico tiene más de 3 horas, se reconstruye en la consulta.
// Solo se leen columnas pensadas para mostrarse a comensales, con lista explícita: nunca select('*') (restaurants trae plan y facturación).
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchSantiagoForecast } from './weather';
import {
    santiagoNow, SNAPSHOT_WEATHER_TTL_MS,
    type OfferSnapshot, type VenuesSnapshot, type WeatherForecast,
} from './rules';

export type SnapshotKind = 'offer' | 'venues' | 'weather';
type Admin = SupabaseClient<any>;

const VENUE_COLUMNS =
    'id, name, description, cuisine_type, price_level, address, comuna, lat, lng, amenities, spaces, capacity, space_capacities, opening_hours, has_takeaway, has_reservations, average_prep_time';
const OFFER_COLUMNS = 'id, restaurant_id, name, description, price, takeaway_price, category, is_menu_del_dia, is_available, disabled_by_stock, stock_managed, current_stock';

/** Locales habilitados para el comensal: activos y con cupo en su plan (mismo criterio que la portada). */
async function enabledRestaurants(admin: Admin, columns: string) {
    const { data, error } = await admin.from('restaurants').select(columns).eq('is_active', true).eq('plan_hidden', false).order('name');
    if (error) throw new Error(`restaurants: ${error.message}`);
    return (data ?? []) as any[];
}

const DAY_KEYS: [string, string[]][] = [
    ['lun', ['mon', 'monday']], ['mar', ['tue', 'tuesday']], ['mie', ['wed', 'wednesday']], ['jue', ['thu', 'thursday']],
    ['vie', ['fri', 'friday']], ['sab', ['sat', 'saturday']], ['dom', ['sun', 'sunday']],
];

/** Horario compacto por día ("12:00-16:00" o "cerrado"). Sin datos de un día, no se inventa: se omite. */
export function compactHours(openingHours: any): Record<string, string> {
    const out: Record<string, string> = {};
    if (!openingHours || typeof openingHours !== 'object') return out;
    for (const [short, keys] of DAY_KEYS) {
        const d = keys.map(k => openingHours[k]).find(x => x && typeof x === 'object');
        if (!d) continue;
        out[short] = d.is_closed ? 'cerrado' : d.open && d.close ? `${d.open}-${d.close}` : 'sin dato';
    }
    return out;
}

function addressText(a: any): string {
    if (typeof a === 'string') return a;
    if (a && typeof a === 'object') return [a.street, a.number].map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).join(' ');
    return '';
}

export async function buildVenuesSnapshot(admin: Admin): Promise<VenuesSnapshot> {
    const rows = await enabledRestaurants(admin, VENUE_COLUMNS);
    return {
        restaurants: rows.map(r => ({
            id: r.id,
            name: r.name ?? '',
            description: r.description ?? '',
            cuisine: r.cuisine_type ?? '',
            priceLevel: Number(r.price_level) || null,
            address: addressText(r.address),
            comuna: r.comuna ?? '',
            lat: typeof r.lat === 'number' ? r.lat : null,
            lng: typeof r.lng === 'number' ? r.lng : null,
            amenities: Array.isArray(r.amenities) ? r.amenities.filter((x: unknown) => typeof x === 'string') : [],
            spaces: Array.isArray(r.spaces) ? r.spaces.filter((x: unknown) => typeof x === 'string') : [],
            capacity: Number(r.capacity) || null,
            spaceCapacities: r.space_capacities && typeof r.space_capacities === 'object'
                ? Object.fromEntries(Object.entries(r.space_capacities).filter(([, n]) => typeof n === 'number')) as Record<string, number>
                : {},
            hours: compactHours(r.opening_hours),
            hasTakeaway: r.has_takeaway ?? true,
            hasReservations: r.has_reservations ?? true,
            avgPrepMinutes: Number(r.average_prep_time) || null,
        })),
    };
}

/** Un plato entra a la oferta si el local lo tiene disponible y, si controla stock, queda stock. */
export function isOfferable(m: any): boolean {
    if (m.is_available !== true || m.disabled_by_stock === true) return false;
    if (m.stock_managed === true && !(Number(m.current_stock) > 0)) return false;
    return true;
}

export async function buildOfferSnapshot(admin: Admin): Promise<OfferSnapshot> {
    const restaurants = await enabledRestaurants(admin, 'id, name, cuisine_type, price_level');
    if (restaurants.length === 0) return { restaurants: [] };
    const { data, error } = await admin.from('menu_items').select(OFFER_COLUMNS).in('restaurant_id', restaurants.map(r => r.id));
    if (error) throw new Error(`menu_items: ${error.message}`);
    const byRestaurant = new Map<string, any[]>();
    for (const m of data ?? []) {
        if (!isOfferable(m)) continue;
        const list = byRestaurant.get(m.restaurant_id) ?? [];
        list.push(m);
        byRestaurant.set(m.restaurant_id, list);
    }
    return {
        restaurants: restaurants.map(r => ({
            id: r.id,
            name: r.name ?? '',
            cuisine: r.cuisine_type ?? '',
            priceLevel: Number(r.price_level) || null,
            items: (byRestaurant.get(r.id) ?? []).map(m => ({
                id: m.id,
                name: m.name ?? '',
                description: m.description ?? '',
                price: typeof m.price === 'number' ? m.price : null,
                takeawayPrice: typeof m.takeaway_price === 'number' ? m.takeaway_price : null,
                category: m.category ?? '',
                menuDelDia: m.is_menu_del_dia === true,
            })),
        })),
    };
}

type Row = { payload: any; built_at: string; stale: boolean };

async function readRow(admin: Admin, day: string, kind: SnapshotKind): Promise<Row | null> {
    const { data, error } = await admin.from('olivia_snapshots').select('payload, built_at, stale').eq('day', day).eq('kind', kind).maybeSingle();
    if (error) throw new Error(`olivia_snapshots: ${error.message}`);
    return (data as Row | null) ?? null;
}

async function writeRow(admin: Admin, day: string, kind: SnapshotKind, payload: unknown, builtAt: Date) {
    const { error } = await admin.from('olivia_snapshots').upsert({ day, kind, payload, built_at: builtAt.toISOString(), stale: false }, { onConflict: 'day,kind' });
    if (error) throw new Error(`olivia_snapshots: ${error.message}`);
}

export type SnapshotResult<T> = { data: T | null; builtAt: Date | null };
export type SnapshotDeps = { now?: Date; fetchImpl?: typeof fetch };

/** Lee la copia de hoy; si falta o quedó desactualizada la reconstruye. `force` reconstruye siempre (lo usa el cron). */
export async function getSnapshot<T = unknown>(admin: Admin, kind: SnapshotKind, deps: SnapshotDeps & { force?: boolean } = {}): Promise<SnapshotResult<T>> {
    const now = deps.now ?? new Date();
    const day = santiagoNow(now).date;
    const row = await readRow(admin, day, kind);
    const fresh = row && !row.stale && (kind !== 'weather' || now.getTime() - new Date(row.built_at).getTime() < SNAPSHOT_WEATHER_TTL_MS);
    if (row && fresh && !deps.force) return { data: row.payload as T, builtAt: new Date(row.built_at) };

    let payload: unknown | null = null;
    try {
        if (kind === 'offer') payload = await buildOfferSnapshot(admin);
        else if (kind === 'venues') payload = await buildVenuesSnapshot(admin);
        else payload = await fetchSantiagoForecast(day, deps.fetchImpl);
    } catch (e) {
        // Sin poder reconstruir, una copia vieja de hoy es mejor que nada (solo se ve ligeramente desfasada).
        console.error(`[olivia] no se pudo reconstruir la copia ${kind}:`, (e as Error).message);
    }
    if (payload == null) return row ? { data: row.payload as T, builtAt: new Date(row.built_at) } : { data: null, builtAt: null };
    await writeRow(admin, day, kind, payload, now);
    return { data: payload as T, builtAt: now };
}

/** Reconstruye las tres copias (cron diario). Cada una por su cuenta: una falla no frena a las otras. */
export async function refreshAllSnapshots(admin: Admin, deps: SnapshotDeps = {}) {
    const out: Record<SnapshotKind, { ok: boolean; error?: string }> = { offer: { ok: true }, venues: { ok: true }, weather: { ok: true } };
    for (const kind of ['offer', 'venues', 'weather'] as const) {
        try {
            const r = await getSnapshot(admin, kind, { ...deps, force: true });
            // El pronóstico puede no estar disponible: no es un error del cron, OlivIA lo avisa en la conversación.
            if (r.data == null && kind !== 'weather') out[kind] = { ok: false, error: 'sin datos' };
        } catch (e) {
            out[kind] = { ok: false, error: (e as Error).message };
        }
    }
    return out;
}

export type { WeatherForecast };
