// Eventos de PLATAFORMA del cliente (los pasos: sesión, registro, descuentos, pago…). Distinto de client-events.ts, que mide lo que
// cada LOCAL puede ver de sus clientes. Catálogo, privacidad y retención: platform-events-catalog.ts y ANALITICA.md (admin-dashboard).
//
// Mismo diseño que client-events.ts:
//  * Todo es secundario: un fallo aquí NUNCA debe afectar la pantalla del cliente (se traga cualquier error).
//  * Se envían en lotes (cada 4 s o al llegar a 20) y, al ocultar o cerrar la pestaña, con sendBeacon.
//  * `once` registra un evento una sola vez por sesión de la app (p. ej. «descuento visto»).
//  * Sin sesión el servidor responde 401: se pausa el envío un rato (no se reintenta en bucle).

import {
    detectPlatform, errorCode, sanitizeProps, sanitizeStep, sanitizeUuid,
    type PlatformEventType, type PlatformName, type PlatformProps, type QueuedPlatformEvent,
} from './platform-events-catalog';

export { errorCode } from './platform-events-catalog';

export interface PlatformTrackerDeps {
    /** Envía un lote. `beacon` = la página se está cerrando. Devuelve el estado HTTP (0 si no se pudo enviar). */
    send: (body: string, beacon: boolean) => Promise<number>;
    now: () => number;
    newId: () => string;
    storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (t: unknown) => void;
    env: () => { platform: PlatformName; standalone?: boolean };
}

export interface TrackOptions {
    step?: string;
    restaurantId?: string;
    discountId?: string;
    refId?: string;
    props?: PlatformProps;
    /** Solo una vez por sesión de la app para esta combinación de tipo, paso y ids. */
    once?: boolean;
}

export const FLUSH_MS = 4_000;
export const MAX_BATCH = 20;
export const MAX_QUEUE = 100;
export const PAUSE_MS = 60_000;
const SID_KEY = 'almuerzo:pev:sid';
const ONCE_KEY = 'almuerzo:pev:once';

export function createPlatformTracker(deps: PlatformTrackerDeps) {
    let queue: QueuedPlatformEvent[] = [];
    let timer: unknown = null;
    let pausedUntil = 0;
    let sid: string | null = null;
    let seen: Set<string> | null = null;
    let inFlight = false;

    const store = () => { try { return deps.storage ?? null; } catch { return null; } };

    function sessionId(): string {
        if (sid) return sid;
        try {
            const saved = store()?.getItem(SID_KEY);
            if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return (sid = saved);
        } catch { /* sin almacenamiento: la sesión vive mientras viva la página */ }
        sid = deps.newId().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36).padEnd(8, '0');
        try { store()?.setItem(SID_KEY, sid); } catch { /* idem */ }
        return sid;
    }

    function seenSet(): Set<string> {
        if (seen) return seen;
        seen = new Set();
        try {
            const raw = store()?.getItem(ONCE_KEY);
            if (raw) for (const k of JSON.parse(raw) as string[]) seen.add(String(k));
        } catch { /* ignorar */ }
        return seen;
    }

    function persistSeen() {
        try { store()?.setItem(ONCE_KEY, JSON.stringify(Array.from(seenSet()).slice(-300))); } catch { /* ignorar */ }
    }

    function schedule() {
        if (timer != null) return;
        timer = deps.setTimer(() => { timer = null; void flush(false); }, FLUSH_MS);
    }

    async function flush(beacon: boolean): Promise<void> {
        if (timer != null) { deps.clearTimer(timer); timer = null; }
        if (!queue.length) return;
        if (deps.now() < pausedUntil) { queue = []; return; }
        if (inFlight && !beacon) { schedule(); return; }
        const batch = queue.slice(0, MAX_BATCH);
        queue = queue.slice(MAX_BATCH);
        inFlight = true;
        try {
            const status = await deps.send(JSON.stringify({ events: batch }), beacon);
            // 401 / 403: sin sesión (o sin permiso). Se pausa y se descarta lo pendiente.
            if (status === 401 || status === 403) { pausedUntil = deps.now() + PAUSE_MS; queue = []; }
        } catch { /* se pierde el lote: es analítica, no datos del cliente */ }
        inFlight = false;
        if (queue.length) schedule();
    }

    /** Devuelve true si el evento quedó en cola. */
    function track(type: PlatformEventType, opts: TrackOptions = {}): boolean {
        try {
            if (deps.now() < pausedUntil) return false;
            const step = sanitizeStep(opts.step);
            const restaurantId = sanitizeUuid(opts.restaurantId);
            const discountId = sanitizeUuid(opts.discountId);
            const refId = sanitizeUuid(opts.refId);

            if (opts.once) {
                const key = `${type}|${step ?? ''}|${restaurantId ?? ''}|${discountId ?? ''}|${refId ?? ''}`;
                const s = seenSet();
                if (s.has(key)) return false;
                s.add(key);
                persistSeen();
            }

            if (queue.length >= MAX_QUEUE) queue.shift();
            const env = deps.env();
            const ev: QueuedPlatformEvent = { type, sessionId: sessionId(), platform: env.platform };
            if (typeof env.standalone === 'boolean') ev.standalone = env.standalone;
            if (step) ev.step = step;
            if (restaurantId) ev.restaurantId = restaurantId;
            if (discountId) ev.discountId = discountId;
            if (refId) ev.refId = refId;
            const props = sanitizeProps(opts.props);
            if (Object.keys(props).length) ev.props = props as PlatformProps;
            queue.push(ev);
            if (queue.length >= MAX_BATCH) void flush(false); else schedule();
            return true;
        } catch { return false; }
    }

    return { track, flush, sessionId, _queue: () => queue };
}

// ───────────── instancia del navegador ─────────────

let browser: ReturnType<typeof createPlatformTracker> | null = null;

function getBrowserTracker() {
    if (browser || typeof window === 'undefined') return browser;
    let storage: PlatformTrackerDeps['storage'] = null;
    try { storage = window.sessionStorage; } catch { storage = null; }

    browser = createPlatformTracker({
        send: async (body, beacon) => {
            try {
                if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
                    return navigator.sendBeacon('/api/platform-events', new Blob([body], { type: 'application/json' })) ? 202 : 0;
                }
                const res = await fetch('/api/platform-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' });
                return res.status;
            } catch { return 0; }
        },
        now: () => Date.now(),
        newId: () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(36).slice(2)}`),
        storage,
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (t) => window.clearTimeout(t as number),
        env: () => {
            let standalone: boolean | undefined;
            try {
                standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
            } catch { standalone = undefined; }
            return { platform: detectPlatform(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0), standalone };
        },
    });

    const onHide = () => { if (document.visibilityState === 'hidden') void browser?.flush(true); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', () => void browser?.flush(true));
    return browser;
}

export function trackPlatformEvent(type: PlatformEventType, opts?: TrackOptions): void {
    try { getBrowserTracker()?.track(type, opts); } catch { /* ignorar */ }
}

/** Para `catch`: registra una falla con un código corto, sin el mensaje del error. */
export function trackFailure(type: 'checkout_error' | 'client_error', err: unknown, opts: Omit<TrackOptions, 'props'> & { props?: PlatformProps } = {}): void {
    trackPlatformEvent(type, { ...opts, props: { ...opts.props, code: errorCode(err) } });
}
