import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/availability?restaurantId&time=<ISO>&partySize — ¿hay cupo en ese horario?
// Envuelve check_restaurant_availability, que solo service_role puede ejecutar. Responde
// { ok: true, isAvailable, remainingSeats } o { ok: false, reason }; si falla, el navegador deja
// pasar (igual que antes) y create_reservation_atomic revalida el cupo al crear la reserva.
export async function GET(req: NextRequest) {
    const p = req.nextUrl.searchParams;
    const restaurantId = p.get('restaurantId') ?? '';
    const time = new Date(p.get('time') ?? '');
    const partySize = Number(p.get('partySize'));

    if (!UUID.test(restaurantId) || Number.isNaN(time.getTime()) || !Number.isInteger(partySize) || partySize < 1 || partySize > 200) {
        return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, reason: 'UNAUTHENTICATED' }, { status: 401 });

    if (!rateLimit(`availability:${user.id}`, 120, 60_000).allowed) {
        return NextResponse.json({ ok: false, reason: 'RATE_LIMITED' }, { status: 429 });
    }

    const { data, error } = await getSupabaseAdmin().rpc('check_restaurant_availability', {
        p_restaurant_id: restaurantId,
        p_selected_time: time.toISOString(),
        p_party_size: partySize,
    });
    if (error) {
        console.error('[Availability] RPC falló:', error.message);
        return NextResponse.json({ ok: false, reason: 'RPC_ERROR' }, { status: 502 });
    }

    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({
        ok: true,
        isAvailable: row?.is_available ?? true,
        remainingSeats: row?.remaining_seats ?? 0,
    });
}
