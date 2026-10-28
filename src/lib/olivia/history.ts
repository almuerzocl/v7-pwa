// Consumo anterior de la propia persona, para que OlivIA le sugiera mejor. Solo platos y locales (con cuántas veces y cuándo fue la
// última): sin montos, sin datos de contacto, sin nada de otros usuarios. Se consulta siempre con el user_id de la sesión validada.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserHistory } from './rules';

const WINDOW_DAYS = 90;
const MAX_ROWS = 200;
const TOP = 5;
const DONE_ORDER = ['ENTREGADO', 'COMPLETADO'];
const DONE_RESERVATION = ['COMPLETADA', 'CHECK-IN CLIENTE'];

const day = (iso: string) => iso.slice(0, 10);

export async function getUserHistory(admin: SupabaseClient<any>, userId: string, now: Date = new Date()): Promise<UserHistory | null> {
    const since = new Date(now.getTime() - WINDOW_DAYS * 86400000).toISOString();
    try {
        const [orders, reservations] = await Promise.all([
            admin.from('takeaway_orders').select('restaurant_id, items, created_at')
                .eq('user_id', userId).in('status', DONE_ORDER).gte('created_at', since).order('created_at', { ascending: false }).limit(MAX_ROWS),
            admin.from('reservations').select('restaurant_id, date_time')
                .or(`organizer_id.eq.${userId},user_id.eq.${userId}`).in('status', DONE_RESERVATION).gte('date_time', since).order('date_time', { ascending: false }).limit(MAX_ROWS),
        ]);
        if (orders.error || reservations.error) throw new Error((orders.error ?? reservations.error)!.message);

        const visits = new Map<string, { veces: number; ultimo: string }>();
        const dishes = new Map<string, { name: string; veces: number }>();
        const touch = (rid: string, at: string) => {
            const v = visits.get(rid) ?? { veces: 0, ultimo: day(at) };
            v.veces += 1;
            if (day(at) > v.ultimo) v.ultimo = day(at);
            visits.set(rid, v);
        };
        for (const o of orders.data ?? []) {
            if (o.restaurant_id) touch(o.restaurant_id, o.created_at);
            for (const it of Array.isArray(o.items) ? o.items : []) {
                const name = typeof it?.name === 'string' ? it.name.trim() : '';
                if (!name) continue;
                const key = name.toLowerCase();
                const d = dishes.get(key) ?? { name, veces: 0 };
                d.veces += Math.max(1, Number(it.quantity) || 1);
                dishes.set(key, d);
            }
        }
        for (const r of reservations.data ?? []) if (r.restaurant_id) touch(r.restaurant_id, r.date_time);

        if (visits.size === 0) return null;
        const ids = Array.from(visits.keys());
        const { data: names, error } = await admin.from('restaurants').select('id, name').in('id', ids);
        if (error) throw new Error(error.message);
        const nameOf = new Map((names ?? []).map((n: any) => [n.id, n.name as string]));

        return {
            restaurants: ids
                .map(id => ({ name: nameOf.get(id) ?? '', ...visits.get(id)! }))
                .filter(r => r.name)
                .sort((a, b) => b.veces - a.veces || (a.ultimo < b.ultimo ? 1 : -1))
                .slice(0, TOP),
            platos: Array.from(dishes.values()).sort((a, b) => b.veces - a.veces).slice(0, TOP).map(({ name, veces }) => ({ name, veces })),
        };
    } catch (e) {
        // El historial es un extra: si falla, OlivIA responde igual sin personalizar.
        console.error('[olivia] historial no disponible:', (e as Error).message);
        return null;
    }
}
