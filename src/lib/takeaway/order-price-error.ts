// Rechazo de precio/opciones al crear un pedido (trigger takeaway_price_guard, migración 047; SQLSTATE PR001).
// `hint` es el código estable: price_mismatch, option_unavailable, option_invalid, option_duplicate, option_min, option_max,
// item_not_found, invalid_quantity o empty_order. En price_mismatch la base entrega el total esperado y las líneas corregidas.
export const PRICE_ERROR = 'price_error' as const;

export interface PriceErrorInfo {
    hint: string;
    message: string;
    expectedTotal?: number;
    lines?: Array<{ id?: string; options?: Array<{ option_id?: string }>; unit_price?: number; base_price?: number }>;
}

export class OrderPriceError extends Error {
    readonly hint: string;
    readonly expectedTotal?: number;
    readonly lines?: PriceErrorInfo['lines'];
    constructor(info: PriceErrorInfo) {
        super(info.message);
        this.name = 'OrderPriceError';
        this.hint = info.hint;
        this.expectedTotal = info.expectedTotal;
        this.lines = info.lines;
    }
}

// Lee el error de la base (supabase-js: { message, code, hint, details }). Devuelve null si no es un rechazo de precio.
export function priceErrorFromDb(err: { message?: string; code?: string; hint?: string | null; details?: string | null } | null | undefined): PriceErrorInfo | null {
    if (!err || err.code !== 'PR001' || !err.hint) return null;
    let expectedTotal: number | undefined;
    let lines: PriceErrorInfo['lines'];
    if (err.hint === 'price_mismatch' && err.details) {
        try {
            const d = JSON.parse(err.details);
            if (typeof d?.expected_total === 'number') expectedTotal = d.expected_total;
            if (Array.isArray(d?.items)) lines = d.items;
        } catch { /* sin detalle: el carrito igual avisa */ }
    }
    return { hint: err.hint, message: err.message || 'Los precios cambiaron: revisa tu pedido', expectedTotal, lines };
}
