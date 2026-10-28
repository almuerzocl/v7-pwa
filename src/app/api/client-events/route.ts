import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const TYPES = new Set(['impression', 'profile_view', 'menu_view', 'share', 'call', 'order_start', 'reservation_start']);
const SURFACES = new Set(['home', 'home_menus', 'favorites', 'modal', 'detail', 'menu', 'cart', 'wizard']);
const MAX_BODY = 16 * 1024;
const MAX_EVENTS = 50;

// POST /api/client-events — lote de eventos de comportamiento del cliente (ver src/lib/client-events.ts).
// Solo con sesión: la persona es el user_id (la PWA exige iniciar sesión). El navegador NUNCA elige el user_id ni la hora: los
// pone el servidor. Escribe con service_role vía record_client_events() (descarta al personal del propio local y aplica un tope por
// usuario). Es analítica: ante cualquier problema responde sin romper nada en el navegador.
export async function POST(req: NextRequest) {
    let raw: string;
    try { raw = await req.text(); } catch { return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' }, { status: 400 }); }
    if (raw.length > MAX_BODY) return NextResponse.json({ ok: false, reason: 'TOO_LARGE' }, { status: 413 });

    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' }, { status: 400 }); }
    const input = parsed?.events;
    if (!Array.isArray(input) || input.length === 0) return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' }, { status: 400 });

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, reason: 'UNAUTHENTICATED' }, { status: 401 });

    if (!rateLimit(`client-events:${user.id}`, 60, 60_000).allowed) {
        return NextResponse.json({ ok: false, reason: 'RATE_LIMITED' }, { status: 429 });
    }

    // Se descarta lo inválido en vez de rechazar todo el lote: un evento mal formado no debe perder los demás.
    const events = input.slice(0, MAX_EVENTS).flatMap((e: any) => {
        if (!e || typeof e !== 'object') return [];
        if (!UUID.test(String(e.restaurantId)) || !TYPES.has(e.type) || !SESSION.test(String(e.sessionId))) return [];
        return [{
            restaurant_id: String(e.restaurantId).toLowerCase(),
            event_type: e.type,
            surface: SURFACES.has(e.surface) ? e.surface : null,
            position: Number.isInteger(e.position) && e.position >= 0 && e.position <= 999 ? e.position : null,
            session_id: String(e.sessionId),
        }];
    });
    if (events.length === 0) return NextResponse.json({ ok: true, inserted: 0 });

    const { data, error } = await getSupabaseAdmin().rpc('record_client_events', { p_user_id: user.id, p_events: events });
    if (error) {
        console.error('[ClientEvents] RPC falló:', error.message);
        return NextResponse.json({ ok: false, reason: 'RPC_ERROR' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, inserted: Number(data?.inserted ?? 0) });
}
