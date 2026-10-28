// Solo servidor. Revalida el descuento elegido justo antes de insertar una reserva o un pedido.
// Si el servicio dice "no vigente" o no responde, se crea SIN descuento (nunca se bloquea).

import {
    buildDiscountNote,
    getDiscountsClient,
    stripDiscountNote,
    type DiscountServiceType,
    type InstitutionDiscount,
} from './discounts';

export type DiscountDropReason = 'NOT_VALID' | 'UNAVAILABLE';

export interface DiscountCheckoutOutcome {
    /** Descuento confirmado vigente (null = sin descuento). */
    discount: InstitutionDiscount | null;
    /** Había uno elegido pero no se pudo confirmar: se crea sin él y hay que avisar al cliente. */
    dropped: { reason: DiscountDropReason; discountName: string } | null;
}

/** Busca el descuento elegido dentro de la lista que el cliente vio (el snapshot). */
export function findChosenDiscount(
    appliedDiscountId: string | null | undefined,
    snapshot: unknown
): InstitutionDiscount | null {
    if (!appliedDiscountId || !Array.isArray(snapshot)) return null;
    return (snapshot as InstitutionDiscount[]).find((d) => d?.discount_id === appliedDiscountId) ?? null;
}

/**
 * Llama a /v1/validate (solo vigencia). El snapshot trae el descuento; si el id elegido no está en él,
 * se descarta sin consultar al servicio.
 */
export async function revalidateChosenDiscount(params: {
    userId: string;
    restaurantId: string;
    serviceType: DiscountServiceType;
    date?: string; // yyyy-MM-dd; por defecto hoy (Santiago)
    appliedDiscountId: string | null | undefined;
    snapshot: unknown;
}): Promise<DiscountCheckoutOutcome> {
    if (!params.appliedDiscountId) return { discount: null, dropped: null };

    const chosen = findChosenDiscount(params.appliedDiscountId, params.snapshot);
    if (!chosen) {
        console.error('[Discounts] descuento elegido ausente del snapshot; se crea sin descuento:', params.appliedDiscountId);
        return { discount: null, dropped: { reason: 'NOT_VALID', discountName: 'El descuento elegido' } };
    }
    const label = `${chosen.institution_name} / ${chosen.discount_name}`;

    const client = getDiscountsClient();
    if (!client) {
        console.error('[Discounts] DISCOUNTS_SERVICE_URL no configurada; se crea sin descuento');
        return { discount: null, dropped: { reason: 'UNAVAILABLE', discountName: label } };
    }

    const res = await client.validate({
        userId: params.userId,
        restaurantId: params.restaurantId,
        discountId: params.appliedDiscountId,
        serviceType: params.serviceType,
        date: params.date,
    });
    if (!res.ok) {
        console.error(`[Discounts] validate falló (${res.error.code}: ${res.error.message}); se crea sin descuento`);
        return { discount: null, dropped: { reason: 'UNAVAILABLE', discountName: label } };
    }
    if (!res.data.valid) {
        console.warn(`[Discounts] descuento ya no vigente (${res.data.reason}); se crea sin descuento`);
        return { discount: null, dropped: { reason: 'NOT_VALID', discountName: label } };
    }
    return { discount: chosen, dropped: null };
}

/** Notas finales: las del cliente (sin ninguna nota de descuento que venga del navegador) + la nota solo si sigue vigente. */
export function composeNotes(clientNotes: string | null | undefined, discount: InstitutionDiscount | null): string {
    return [stripDiscountNote(clientNotes), discount ? buildDiscountNote(discount) : ''].filter(Boolean).join('\n');
}

/** Aviso para el cliente cuando el descuento se descartó. */
export function droppedDiscountMessage(
    dropped: NonNullable<DiscountCheckoutOutcome['dropped']>,
    serviceType: DiscountServiceType
): string {
    const what = serviceType === 'reservation' ? 'reserva' : 'pedido';
    return dropped.reason === 'NOT_VALID'
        ? `El descuento ${dropped.discountName} ya no estaba vigente: tu ${what} se creó sin descuento.`
        : `No pudimos confirmar el descuento ${dropped.discountName} en este momento: tu ${what} se creó sin descuento.`;
}
