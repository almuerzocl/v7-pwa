// Suscripción ELITE de comensales (migración 041). La verdad vive en la base (`is_elite()` decide por fechas sobre `elite_periods`);
// aquí solo se interpreta lo que ella dejó, sin dependencias de servidor: lo usan acciones y pantallas.

/** Producto de la tienda. La compra la activa el admin-dashboard (único repo que habla con Shopify) por el correo del pedido. */
export const ELITE_PRODUCT_URL = 'https://almuerzo.cl/products/suscripcion-elite-comensales';

/** Días de gracia tras terminar un período (mismo valor que `is_elite()` en la base). */
export const ELITE_GRACE_DAYS = 3;

export type EliteStatus = {
    active: boolean;
    /** Fin del último período vigente (ISO); null si nunca tuvo ELITE o ya no corre ninguno. */
    endsAt: string | null;
    /** Hay una compra pagada con el correo de la cuenta que aún se está procesando. */
    pending: boolean;
};

export type EliteScope = 'reservation' | 'takeaway';

/** Reputación que ve el cliente: 100 mientras la cuenta sea ELITE; si no, la real del perfil (null si no se pudo leer). */
export function displayReputation(
    profile: { account_type?: string | null; reservation_reputation?: number | null; takeaway_reputation?: number | null } | null | undefined,
    scope: EliteScope,
): number | null {
    if (!profile) return null;
    if (profile.account_type === 'elite') return 100;
    const v = scope === 'reservation' ? profile.reservation_reputation : profile.takeaway_reputation;
    return typeof v === 'number' ? v : null;
}

export interface PeriodRow { starts_at: string; ends_at: string; status: string }

/** Estado ELITE a partir de los períodos (misma regla que `is_elite()`: no anulado, ya empezó, y hasta 3 días después del fin). */
export function eliteStatusFrom(periods: readonly PeriodRow[], pendingOrders: number, now: Date = new Date()): EliteStatus {
    const grace = ELITE_GRACE_DAYS * 24 * 3600 * 1000;
    const live = periods.filter((p) => p.status !== 'anulado' && Date.parse(p.starts_at) <= now.getTime() && now.getTime() < Date.parse(p.ends_at) + grace);
    const active = live.length > 0;
    // El «hasta cuándo» incluye lo ya pagado por adelantado (períodos en cola): el último fin de todos los no anulados que empezaron o van a empezar.
    const ends = periods.filter((p) => p.status !== 'anulado').map((p) => Date.parse(p.ends_at));
    const endsAt = active && ends.length ? new Date(Math.max(...ends)).toISOString() : null;
    return { active, endsAt, pending: pendingOrders > 0 };
}
