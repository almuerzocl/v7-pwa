import { NextRequest, NextResponse } from 'next/server';
import { createTakeawayOrder, type TakeawayOrderRow } from '@/lib/takeaway/create-takeaway-order';

export const dynamic = 'force-dynamic';

// POST /api/takeaway-orders — crea un pedido. Revalida el descuento elegido en el servidor antes de insertar
// (no se puede saltar desde el navegador). Códigos: 400 body inválido, 401 sin sesión o sesión de otro
// usuario, 422 rechazo de negocio/base (sin stock, etc.), 200 creado.
export async function POST(req: NextRequest) {
    let row: TakeawayOrderRow;
    try {
        row = await req.json();
    } catch {
        return NextResponse.json({ success: false, error: 'Solicitud inválida' }, { status: 400 });
    }
    if (!row || typeof row.user_id !== 'string' || typeof row.restaurant_id !== 'string') {
        return NextResponse.json({ success: false, error: 'Solicitud inválida' }, { status: 400 });
    }

    const result = await createTakeawayOrder(row);
    if (result.success) return NextResponse.json(result);
    return NextResponse.json(result, { status: result.unauthorized ? 401 : 422 });
}
