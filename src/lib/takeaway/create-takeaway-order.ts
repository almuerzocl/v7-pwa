import { createClient } from "@/utils/supabase/server";
import { verifyUser } from "@/utils/supabase/auth-check";
import { processOrderConfirmations } from "@/lib/server/order-confirmation";
import { limitInfoFromDbError, limitReachedMessage, LIMIT_REACHED, type OperationLimitInfo } from "@/lib/operation-limits";
import { priceErrorFromDb, PRICE_ERROR, type PriceErrorInfo } from './order-price-error';
import { revalidateChosenDiscount, composeNotes, droppedDiscountMessage } from "@/lib/core-business/discount-checkout";

// Fila a insertar en takeaway_orders, tal como la arma el carrito. Los campos de descuento
// (discount_data_snapshot, metadata.applied_discount_id, metadata.special_requests) vienen del navegador y
// se REESCRIBEN aquí según el resultado de la revalidación.
export type TakeawayOrderRow = Record<string, any> & {
    user_id: string;
    restaurant_id: string;
};

export type CreateTakeawayOrderResult =
    | { success: true; order: { id: string; [k: string]: unknown }; discountDropped?: { reason: 'NOT_VALID' | 'UNAVAILABLE'; message: string } }
    | { success: false; error: string; unauthorized?: boolean; code?: typeof LIMIT_REACHED | typeof PRICE_ERROR; limitReached?: OperationLimitInfo | null; priceError?: PriceErrorInfo };

// Única vía para crear un pedido (flujo online y reintento de la cola offline): POST /api/takeaway-orders.
// El insert usa la sesión del usuario (no service role), así que las políticas RLS y los guards de stock
// de la base siguen aplicando igual que cuando el navegador insertaba directo.
export async function createTakeawayOrder(row: TakeawayOrderRow): Promise<CreateTakeawayOrderResult> {
    const auth = await verifyUser(row.user_id);
    if (!auth.authorized) return { success: false, error: auth.error, unauthorized: true };

    const metadata = { ...(row.metadata ?? {}) };
    const outcome = await revalidateChosenDiscount({
        userId: row.user_id,
        restaurantId: row.restaurant_id,
        serviceType: 'takeaway',
        appliedDiscountId: metadata.applied_discount_id,
        snapshot: row.discount_data_snapshot,
    });

    metadata.applied_discount_id = outcome.discount?.discount_id ?? null;
    metadata.special_requests = composeNotes(metadata.special_requests, outcome.discount) || null;

    const toInsert = {
        ...row,
        discount_data_snapshot: outcome.discount ? row.discount_data_snapshot : null,
        metadata,
    };

    const supabase = await createClient();
    const { data, error } = await supabase.from("takeaway_orders").insert(toInsert as never).select().single();
    if (error) {
        // Tope de operaciones (migración 040): la base rechaza con HINT limit_reached. Se devuelve con código estable y un
        // mensaje amable, nunca el error crudo.
        if (error.hint === LIMIT_REACHED) {
            const limitReached = limitInfoFromDbError(error);
            return { success: false, error: limitReachedMessage(limitReached), code: LIMIT_REACHED, limitReached };
        }
        // Precio/opciones (migración 047): la base recalculó y rechazó. Se devuelve el código estable y, si cambió el precio, las líneas corregidas.
        const priceError = priceErrorFromDb(error);
        if (priceError) return { success: false, error: priceError.message, code: PRICE_ERROR, priceError };
        console.error("[createTakeawayOrder] insert error:", error);
        // El mensaje viaja tal cual: el carrito reconoce el rechazo de stock (SIN_STOCK|...) en él.
        return { success: false, error: error.message };
    }

    // Correo "Pedido confirmado": solo si el pedido nació APROBADA (autoaprobado por la base). Un pedido PENDIENTE no envía
    // nada: el correo sale cuando el restaurante lo aprueba (cron de 1 min). Aviso en línea, sin bloquear la creación.
    if ((data as { status?: string }).status === 'APROBADA') {
        try {
            await processOrderConfirmations({ id: (data as { id: string }).id });
        } catch (e) {
            console.error('[createTakeawayOrder] Aviso en línea falló; lo reintenta el cron:', e);
        }
    }

    return {
        success: true,
        order: data as { id: string },
        ...(outcome.dropped && {
            discountDropped: { reason: outcome.dropped.reason, message: droppedDiscountMessage(outcome.dropped, 'takeaway') },
        }),
    };
}
