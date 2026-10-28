// Catálogo y validación de los eventos de PLATAFORMA (PWA -> /api/platform-events -> platform_events).
// Lo comparten el navegador (que limpia antes de enviar) y el servidor (que vuelve a validar: el navegador no es de fiar)
// y coincide con el CHECK de la tabla y con la lista blanca de record_platform_events() (migración `platform_events`, admin-dashboard).
//
// Privacidad: solo con sesión, SIN texto libre (ni búsquedas, ni direcciones, ni nombres): solo categorías, números enteros
// acotados e ids. Detalle 30 días, después queda un resumen diario sin identificar a nadie. Ver /privacidad.

export const PLATFORM_EVENT_TYPES = [
    'session_start', 'login', 'signup_complete', 'onboarding_step', 'onboarding_complete',
    'pwa_install_prompt', 'pwa_installed', 'push_permission',
    'search', 'filter_apply', 'location_set', 'favorite_toggle', 'daily_menu_subscribe',
    'discount_view', 'discount_apply', 'discount_remove',
    'cart_view', 'checkout_start', 'checkout_step', 'checkout_submit', 'checkout_error',
    'ticket_view', 'ticket_share', 'cancel_start',
    'client_error', 'offline_queue',
] as const;
export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export type PlatformName = 'ios' | 'android' | 'desktop' | 'other';

export interface PlatformProps {
    count?: number;
    step_index?: number;
    ms?: number;
    filter?: string;
    source?: string;
    code?: string;
    kind?: 'reservation' | 'order';
    result?: 'ok' | 'error' | 'cancelled';
}

/** Lo que viaja del navegador al servidor. */
export interface QueuedPlatformEvent {
    type: PlatformEventType;
    sessionId: string;
    step?: string;
    restaurantId?: string;
    discountId?: string;
    refId?: string;
    platform: PlatformName;
    standalone?: boolean;
    props?: PlatformProps;
}

/** Lo que recibe record_platform_events() (snake_case). */
export interface ServerPlatformEvent {
    event_type: PlatformEventType;
    session_id: string;
    step: string | null;
    restaurant_id: string | null;
    discount_id: string | null;
    ref_id: string | null;
    platform: PlatformName;
    standalone: boolean | null;
    props: Record<string, number | string>;
}

const TYPE_SET: ReadonlySet<string> = new Set(PLATFORM_EVENT_TYPES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const STEP = /^[a-z0-9_:-]{1,40}$/;
const SAFE_TEXT = /^[A-Za-z0-9_.:-]{1,40}$/;
const NUM_KEYS = ['count', 'step_index', 'ms'] as const;
const STR_KEYS = ['filter', 'source', 'code', 'kind', 'result'] as const;

export const isPlatformEventType = (t: unknown): t is PlatformEventType => typeof t === 'string' && TYPE_SET.has(t);
export const sanitizeStep = (s: unknown): string | undefined => (typeof s === 'string' && STEP.test(s) ? s : undefined);
export const sanitizeUuid = (u: unknown): string | undefined => (typeof u === 'string' && UUID.test(u) ? u.toLowerCase() : undefined);
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && SESSION.test(s);

/** Solo claves de la lista blanca: enteros de 0 a 999999 y textos cortos de caracteres seguros. Lo demás se descarta. */
export function sanitizeProps(raw: unknown): Record<string, number | string> {
    const out: Record<string, number | string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const r = raw as Record<string, unknown>;
    for (const k of NUM_KEYS) {
        const v = r[k];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 999_999) out[k] = v;
    }
    for (const k of STR_KEYS) {
        const v = r[k];
        if (typeof v === 'string' && SAFE_TEXT.test(v)) out[k] = v;
    }
    return out;
}

/** Valida un evento recibido en el servidor. Devuelve null si no sirve (se descarta solo ese evento). */
export function sanitizePlatformEvent(raw: unknown): ServerPlatformEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    if (!isPlatformEventType(e.type) || !isSessionId(e.sessionId)) return null;
    const platform: PlatformName = e.platform === 'ios' || e.platform === 'android' || e.platform === 'desktop' ? e.platform : 'other';
    return {
        event_type: e.type,
        session_id: e.sessionId,
        step: sanitizeStep(e.step) ?? null,
        restaurant_id: sanitizeUuid(e.restaurantId) ?? null,
        discount_id: sanitizeUuid(e.discountId) ?? null,
        ref_id: sanitizeUuid(e.refId) ?? null,
        platform,
        standalone: typeof e.standalone === 'boolean' ? e.standalone : null,
        props: sanitizeProps(e.props),
    };
}

/** Código corto y seguro para un error (nunca su mensaje: puede traer datos personales). */
export function errorCode(err: unknown): string {
    const candidate = err && typeof err === 'object'
        ? ((err as { code?: unknown }).code ?? (err as { name?: unknown }).name)
        : undefined;
    const text = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : 'unknown';
    return text.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 40) || 'unknown';
}

export function detectPlatform(userAgent: string, maxTouchPoints: number): PlatformName {
    if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(userAgent)) return 'android';
    if (userAgent) return 'desktop';
    return 'other';
}
