import type { CreateTakeawayOrderResult } from './create-takeaway-order';
import { OperationLimitError } from '@/lib/operation-limits';
import { OrderPriceError, PRICE_ERROR } from './order-price-error';

export type CreatedTakeawayOrder = {
    order: { id: string; [k: string]: unknown };
    discountDropped?: { reason: 'NOT_VALID' | 'UNAVAILABLE'; message: string };
};

/**
 * Crea un pedido vía POST /api/takeaway-orders con un fetch() plano (mismo criterio que
 * create-reservation-client.ts: sirve igual para el flujo online y para el reintento de la cola offline).
 *
 * - Fallo de red → `fetch` tira TypeError ("Failed to fetch"), que `callWithOfflineQueue` reconoce y encola.
 * - Rechazo (sin stock, sesión inválida) → tira Error con el mensaje del servidor (el carrito lo traduce con
 *   parseStockError); no parece de red, así que no se encola ni se reintenta a ciegas.
 */
export async function createTakeawayOrderRequest(row: Record<string, unknown>): Promise<CreatedTakeawayOrder> {
    const res = await fetch('/api/takeaway-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
        credentials: 'same-origin',
    });

    const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
    if (!isJson) {
        throw new Error(
            res.redirected
                ? 'Tu sesión expiró. Por favor, recarga la página e inicia sesión nuevamente.'
                : `Respuesta inesperada del servidor (${res.status}).`
        );
    }
    const json = (await res.json()) as CreateTakeawayOrderResult;
    if (!json.success) {
        if (json.code === PRICE_ERROR && json.priceError) throw new OrderPriceError(json.priceError);
        if (json.code === 'limit_reached') throw new OperationLimitError(json.limitReached ?? null);
        throw new Error(json.error || 'No pudimos crear el pedido.');
    }
    return { order: json.order, discountDropped: json.discountDropped };
}
