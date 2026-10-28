/**
 * Cliente único de descuentos de la PWA.
 *
 * Toda consulta de descuentos pasa por el servicio `almuerzo-discounts` (única fuente de las reglas
 * de vigencia; ver v6/produccion/discounts/docs/CONTRATO.md). Este archivo tiene tres partes:
 *  1. Tipos y helpers de presentación (puros, usables en el navegador).
 *  2. `DiscountsClient`: llamada servicio a servicio con timeout, sin reintentos y con circuito.
 *     Solo se usa en el servidor (necesita DISCOUNTS_SERVICE_URL y la identidad de Cloud Run).
 *  3. `loadEligibleDiscounts`: lo que llama el navegador, vía GET /api/discounts.
 *
 * Regla de oro: el servicio de descuentos NUNCA bloquea una reserva ni un pedido. Todo fallo
 * (caída, lentitud, error) se traduce en "sin descuentos" y se registra en consola.
 */

export type DiscountServiceType = 'reservation' | 'takeaway';

export interface InstitutionDiscount {
    discount_id: string;
    institution_id: string;
    institution_name: string;
    institution_logo_url: string | null;
    discount_name: string;
    amount: number;
    amount_type: 'percent' | 'fixed' | string;
    conditions: string | null;
}

/** Texto que el cliente ve cuando el servicio no responde (no es un error genérico). */
export const DISCOUNTS_UNAVAILABLE_MESSAGE = 'Los descuentos no están disponibles en este momento.';

/** Format discount amount for display: "15%" or "$2.000" */
export function formatDiscountAmount(amount: number, amountType: string): string {
    if (amountType === 'percent') return `${amount}%`;
    return `$${amount.toLocaleString('es-CL')}`;
}

const DISCOUNT_NOTE_PREFIX = 'El usuario desea aplicar el descuento de:';

/** Build the special notes string for a selected discount. */
export function buildDiscountNote(discount: InstitutionDiscount): string {
    const amountStr = formatDiscountAmount(discount.amount, discount.amount_type);
    return `${DISCOUNT_NOTE_PREFIX} ${discount.institution_name} / ${discount.discount_name} / ${amountStr}.`;
}

/** Quita de un texto toda línea que sea una nota de descuento (el servidor la reescribe si el descuento sigue vigente). */
export function stripDiscountNote(text: string | null | undefined): string {
    return (text ?? '')
        .split('\n')
        .filter((line) => !line.trim().startsWith(DISCOUNT_NOTE_PREFIX))
        .join('\n')
        .trim();
}

// ───────────────────────── Cliente servicio a servicio (servidor) ─────────────────────────

export type ClientErrorCode = 'CIRCUIT_OPEN' | 'TIMEOUT' | 'UNAVAILABLE' | 'BAD_REQUEST' | 'SERVER_ERROR';
export type DiscountsResult<T> = { ok: true; data: T } | { ok: false; error: { code: ClientErrorCode; message: string } };

interface DiscountsClientOptions {
    baseUrl: string;
    getAuthHeaders?: () => Promise<Record<string, string>>;
    timeoutMs?: number;
    failureThreshold?: number;
    cooldownMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
}

/**
 * - Nunca lanza: devuelve `{ ok: false, error }`.
 * - Timeout propio por llamada (2,5 s) que cubre token + fetch + lectura.
 * - SIN reintentos.
 * - Circuito: tras 3 fallas seguidas (timeout, red, 5xx) se abre 30 s y falla al instante;
 *   luego deja pasar UNA llamada de prueba. Un 4xx no cuenta (es error del llamador).
 */
export class DiscountsClient {
    private readonly timeoutMs: number;
    private readonly failureThreshold: number;
    private readonly cooldownMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;

    private consecutiveFailures = 0;
    private openUntil = 0;
    private probing = false;

    constructor(private readonly opts: DiscountsClientOptions) {
        this.timeoutMs = opts.timeoutMs ?? 2500;
        this.failureThreshold = opts.failureThreshold ?? 3;
        this.cooldownMs = opts.cooldownMs ?? 30000;
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.now = opts.now ?? Date.now;
    }

    eligible(p: { userId: string; restaurantId: string; serviceType: DiscountServiceType; date?: string }) {
        const qs = new URLSearchParams({ userId: p.userId, restaurantId: p.restaurantId, serviceType: p.serviceType });
        if (p.date) qs.set('date', p.date);
        return this.call<{ date: string; discounts: InstitutionDiscount[] }>('GET', `/v1/eligible?${qs}`);
    }

    validate(p: { userId: string; restaurantId: string; discountId: string; serviceType: DiscountServiceType; date?: string }) {
        return this.call<{ valid: boolean; reason: string }>('POST', '/v1/validate', p);
    }

    private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<DiscountsResult<T>> {
        const gate = this.gate();
        if (gate) return gate;

        const ctrl = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        // No depende de que `fetch` respete la señal de abortar.
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                ctrl.abort();
                reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
            }, this.timeoutMs);
        });
        try {
            return await Promise.race([this.exchange<T>(method, path, body, ctrl.signal), timeout]);
        } catch (err) {
            const aborted = ctrl.signal.aborted || (err as Error)?.name === 'AbortError';
            return this.fail(aborted ? 'TIMEOUT' : 'UNAVAILABLE', aborted ? 'Tiempo límite excedido' : 'Servicio no disponible');
        } finally {
            clearTimeout(timer);
        }
    }

    private async exchange<T>(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<DiscountsResult<T>> {
        const auth = this.opts.getAuthHeaders ? await this.opts.getAuthHeaders() : {};
        const res = await this.fetchImpl(this.opts.baseUrl.replace(/\/$/, '') + path, {
            method,
            headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal,
        });
        if (res.status >= 500) {
            return this.fail('SERVER_ERROR', `almuerzo-discounts respondió ${res.status}`);
        }
        if (!res.ok) {
            this.success(); // el servicio responde bien: el error es del llamador
            const msg = await res.json().then((j: { error?: { message?: string } }) => j?.error?.message, () => undefined);
            return { ok: false, error: { code: 'BAD_REQUEST', message: msg ?? `HTTP ${res.status}` } };
        }
        const data = (await res.json()) as T;
        this.success();
        return { ok: true, data };
    }

    /** Fallo inmediato si el circuito está abierto; null si se puede llamar. */
    private gate(): DiscountsResult<never> | null {
        if (this.consecutiveFailures < this.failureThreshold) return null;
        if (this.now() < this.openUntil || this.probing) {
            return { ok: false, error: { code: 'CIRCUIT_OPEN', message: 'Circuito abierto' } };
        }
        this.probing = true; // semiabierto: una sola llamada de prueba
        return null;
    }

    private success() {
        this.consecutiveFailures = 0;
        this.probing = false;
    }

    private fail(code: ClientErrorCode, message: string): DiscountsResult<never> {
        this.consecutiveFailures++;
        this.probing = false;
        if (this.consecutiveFailures >= this.failureThreshold) this.openUntil = this.now() + this.cooldownMs;
        return { ok: false, error: { code, message } };
    }
}

// Identidad de la PWA ante Cloud Run (invocación autenticada): ID token del servidor de metadatos,
// con audiencia = URL del servicio. En local (http://localhost, p. ej. `gcloud run services proxy`)
// no hace falta.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function cloudRunAuthHeaders(baseUrl: string): Promise<Record<string, string>> {
    if (baseUrl.startsWith('http://')) return {};
    if (cachedToken && cachedToken.expiresAt > Date.now()) return { Authorization: `Bearer ${cachedToken.value}` };
    const res = await fetch(
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(baseUrl)}`,
        { headers: { 'Metadata-Flavor': 'Google' } }
    );
    if (!res.ok) throw new Error(`metadata server respondió ${res.status}`);
    cachedToken = { value: await res.text(), expiresAt: Date.now() + 50 * 60 * 1000 };
    return { Authorization: `Bearer ${cachedToken.value}` };
}

let sharedClient: DiscountsClient | null = null;

/** Instancia única por proceso (el circuito vive aquí). null si no hay DISCOUNTS_SERVICE_URL. */
export function getDiscountsClient(): DiscountsClient | null {
    const baseUrl = process.env.DISCOUNTS_SERVICE_URL;
    if (!baseUrl) return null;
    if (!sharedClient) {
        sharedClient = new DiscountsClient({ baseUrl, getAuthHeaders: () => cloudRunAuthHeaders(baseUrl) });
    }
    return sharedClient;
}

// ───────────────────────── Lado navegador ─────────────────────────

export interface EligibleDiscountsResult {
    discounts: InstitutionDiscount[];
    /** true si el servicio no respondió: mostrar "descuentos no disponibles", no un error genérico. */
    unavailable: boolean;
}

const BROWSER_TIMEOUT_MS = 3000;

/** Descuentos vigentes del usuario en sesión para ese restaurante/servicio/fecha. Nunca lanza. */
export async function loadEligibleDiscounts(
    restaurantId: string,
    serviceType: DiscountServiceType,
    date?: string // yyyy-MM-dd
): Promise<EligibleDiscountsResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BROWSER_TIMEOUT_MS);
    try {
        const qs = new URLSearchParams({ restaurantId, serviceType });
        if (date) qs.set('date', date);
        const res = await fetch(`/api/discounts?${qs}`, { credentials: 'same-origin', signal: ctrl.signal });
        const json = await res.json();
        if (json?.ok && Array.isArray(json.discounts)) return { discounts: json.discounts, unavailable: false };
        console.error('[Discounts] Servicio de descuentos no disponible:', json?.reason ?? res.status);
        return { discounts: [], unavailable: true };
    } catch (err) {
        console.error('[Discounts] No se pudo consultar los descuentos:', err);
        return { discounts: [], unavailable: true };
    } finally {
        clearTimeout(timer);
    }
}
