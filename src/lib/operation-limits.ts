// Límite de operaciones por cliente (migración 040). La regla vive en la base; esto solo interpreta lo que ella responde
// y arma los textos que ve el cliente. Sin dependencias de servidor: lo usan acciones, rutas y pantallas.

export type OperationLimitInfo = {
    limit: 'daily' | 'weekly';
    limit_value: number;
    used: number;
    resets_at: string;
};

export type OperationUsage = {
    enabled: boolean;
    elite: boolean;
    limited: boolean;
    daily_used: number;
    daily_limit: number;
    daily_resets_at: string;
    weekly_used: number;
    weekly_limit: number;
    weekly_resets_at: string;
};

/** Código estable con el que la base rechaza (HINT del trigger, `code` de create_reservation_atomic). */
export const LIMIT_REACHED = 'limit_reached';

/** Lee el detalle del rechazo (objeto o JSON en texto). Devuelve null si no es un límite válido. */
export function parseLimitInfo(input: unknown): OperationLimitInfo | null {
    let raw: unknown = input;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { return null; }
    }
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.limit !== 'daily' && o.limit !== 'weekly') return null;
    if (typeof o.limit_value !== 'number' || typeof o.used !== 'number' || typeof o.resets_at !== 'string') return null;
    return { limit: o.limit, limit_value: o.limit_value, used: o.used, resets_at: o.resets_at };
}

/** Error de PostgREST (`{ hint, details }`) → info de límite, o null si el error es otro. */
export function limitInfoFromDbError(err: { hint?: string | null; details?: string | null } | null | undefined): OperationLimitInfo | null {
    if (!err || err.hint !== LIMIT_REACHED) return null;
    return parseLimitInfo(err.details);
}

const operaciones = (n: number) => `${n} ${n === 1 ? 'operación' : 'operaciones'}`;

/** Mensaje para el cliente al llegar al tope. Nunca muestra el error crudo. */
export function limitReachedMessage(info: OperationLimitInfo | null): string {
    if (!info) return 'Llegaste a tu límite de operaciones. Con Elite no tienes límite.';
    if (info.limit === 'weekly') {
        return `Llegaste a tu límite de ${operaciones(info.limit_value)} por esta semana; podrás volver a pedir o reservar el lunes. Con Elite no tienes límite.`;
    }
    return `Llegaste a tu límite de ${operaciones(info.limit_value)} por hoy; podrás volver a pedir o reservar mañana. Con Elite no tienes límite.`;
}

/** Error que viaja del cliente HTTP al carrito, para mostrar el mensaje amable. */
export class OperationLimitError extends Error {
    info: OperationLimitInfo | null;
    constructor(info: OperationLimitInfo | null) {
        super(limitReachedMessage(info));
        this.name = 'OperationLimitError';
        this.info = info;
    }
}

/** "Hoy 1 de 2 · Esta semana 4 de 10". */
export function usageLine(u: Pick<OperationUsage, 'daily_used' | 'daily_limit' | 'weekly_used' | 'weekly_limit'>): string {
    return `Hoy ${u.daily_used} de ${u.daily_limit} · Esta semana ${u.weekly_used} de ${u.weekly_limit}`;
}

/** ¿Al cliente le queda cupo hoy y esta semana? (solo informativo; la base decide). */
export function hasRoom(u: Pick<OperationUsage, 'daily_used' | 'daily_limit' | 'weekly_used' | 'weekly_limit'>): boolean {
    return u.daily_used < u.daily_limit && u.weekly_used < u.weekly_limit;
}
