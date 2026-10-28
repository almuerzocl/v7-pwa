import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// GET /api/restaurants-with-discounts — restaurantes con algún descuento hoy y los logos de sus
// instituciones (para el listado de inicio). Envuelve get_restaurants_with_discounts_today, que solo
// service_role puede ejecutar. Siempre 200 con { ok, restaurants } o { ok: false, reason }: si falla,
// el listado se muestra sin logos de descuento (el mismo comportamiento que ya tenía ante un error).
export async function GET() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, reason: 'UNAUTHENTICATED' }, { status: 401 });

    if (!rateLimit(`restaurants-discounts:${user.id}`, 60, 60_000).allowed) {
        return NextResponse.json({ ok: false, reason: 'RATE_LIMITED' }, { status: 429 });
    }

    const { data, error } = await getSupabaseAdmin().rpc('get_restaurants_with_discounts_today');
    if (error) {
        console.error('[RestaurantsWithDiscounts] RPC falló:', error.message);
        return NextResponse.json({ ok: false, reason: 'RPC_ERROR' });
    }

    const restaurants = (data ?? []).map((d: { restaurant_id: string; institution_logos: string[] | null }) => ({
        restaurantId: d.restaurant_id,
        logos: d.institution_logos ?? [],
    }));
    return NextResponse.json({ ok: true, restaurants });
}
