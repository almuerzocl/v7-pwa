import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { getDiscountsClient, type DiscountServiceType } from '@/lib/core-business/discounts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/discounts?restaurantId&serviceType[&date] — descuentos vigentes del usuario en sesión.
// Siempre responde 200 con { ok, discounts } o { ok: false, reason }: si el servicio de descuentos cae,
// el navegador muestra "descuentos no disponibles" y la reserva/pedido sigue sin descuento.
export async function GET(req: NextRequest) {
    const p = req.nextUrl.searchParams;
    const restaurantId = p.get('restaurantId') ?? '';
    const serviceType = p.get('serviceType') as DiscountServiceType | null;
    const date = p.get('date') ?? undefined;

    if (!UUID.test(restaurantId) || (serviceType !== 'reservation' && serviceType !== 'takeaway') || (date && !DATE.test(date))) {
        return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' }, { status: 400 });
    }

    // El usuario sale de la sesión, nunca de la URL.
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, reason: 'UNAUTHENTICATED' }, { status: 401 });

    const client = getDiscountsClient();
    if (!client) {
        console.error('[Discounts] DISCOUNTS_SERVICE_URL no configurada');
        return NextResponse.json({ ok: false, reason: 'NOT_CONFIGURED' });
    }

    const res = await client.eligible({ userId: user.id, restaurantId, serviceType, date });
    if (!res.ok) {
        console.error(`[Discounts] eligible falló (${res.error.code}): ${res.error.message}`);
        return NextResponse.json({ ok: false, reason: res.error.code });
    }
    return NextResponse.json({ ok: true, discounts: res.data.discounts });
}
