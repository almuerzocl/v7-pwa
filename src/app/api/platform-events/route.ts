import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { rateLimit } from '@/lib/rate-limit';
import { sanitizePlatformEvent } from '@/lib/platform-events-catalog';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const MAX_BODY = 32 * 1024;
const MAX_EVENTS = 50;

// POST /api/platform-events — lote de eventos de comportamiento de la plataforma (ver src/lib/platform-events.ts).
// Solo con sesión: la persona es el user_id. El navegador NUNCA elige el user_id ni la hora: los pone el servidor. Cada evento se
// valida de nuevo aquí (catálogo cerrado, ids y textos con forma segura, sin texto libre) y record_platform_events() lo vuelve a
// validar en la base y aplica un tope por usuario. Es analítica: ante cualquier problema responde sin romper nada en el navegador.
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

    if (!rateLimit(`platform-events:${user.id}`, 120, 60_000).allowed) {
        return NextResponse.json({ ok: false, reason: 'RATE_LIMITED' }, { status: 429 });
    }

    // Se descarta lo inválido en vez de rechazar todo el lote: un evento mal formado no debe perder los demás.
    const events = input.slice(0, MAX_EVENTS).flatMap((e: unknown) => {
        const ok = sanitizePlatformEvent(e);
        return ok ? [ok] : [];
    });
    if (events.length === 0) return NextResponse.json({ ok: true, inserted: 0 });

    const { data, error } = await getSupabaseAdmin().rpc('record_platform_events', { p_user_id: user.id, p_events: events });
    if (error) {
        console.error('[PlatformEvents] RPC falló:', error.message);
        return NextResponse.json({ ok: false, reason: 'RPC_ERROR' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, inserted: Number((data as { inserted?: number } | null)?.inserted ?? 0) });
}
