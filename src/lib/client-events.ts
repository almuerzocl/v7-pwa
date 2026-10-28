// Eventos de CLIENTE (PWA -> /api/client-events -> restaurant_client_events). Alimentan el embudo del reporte del restaurante
// (impresiones, visitas al perfil, carta, compartir, llamar, intención de pedir o reservar).
//
// Diseño:
//  * Todo es secundario: un fallo aquí NUNCA debe afectar la pantalla del cliente (se traga cualquier error).
//  * Se envían en lotes (cada 4 s o al llegar a 20) y, al ocultar o cerrar la pestaña, con sendBeacon.
//  * Una impresión se registra una vez por sesión, local y superficie (además el servidor lo impone).
//  * Sin sesión el servidor responde 401: se pausa el envío un rato (no se reintenta en bucle).
//  * El local solo ve totales y personas distintas, nunca quién fue (ver /privacidad).

export type ClientEventType = 'impression' | 'profile_view' | 'menu_view' | 'share' | 'call' | 'order_start' | 'reservation_start';
export type ClientSurface = 'home' | 'home_menus' | 'favorites' | 'modal' | 'detail' | 'menu' | 'cart' | 'wizard';

export interface QueuedEvent {
    restaurantId: string;
    type: ClientEventType;
    surface?: ClientSurface;
    position?: number;
    sessionId: string;
}

export interface TrackerDeps {
    /** Envía un lote. `beacon` = la página se está cerrando. Devuelve el estado HTTP (0 si no se pudo enviar). */
    send: (body: string, beacon: boolean) => Promise<number>;
    now: () => number;
    newId: () => string;
    storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (t: unknown) => void;
}

export const FLUSH_MS = 4_000;
export const MAX_BATCH = 20;
export const MAX_QUEUE = 100;
export const PAUSE_MS = 60_000;
const SID_KEY = 'almuerzo:ev:sid';
const IMP_KEY = 'almuerzo:ev:imp';

export function createTracker(deps: TrackerDeps) {
    let queue: QueuedEvent[] = [];
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
            const raw = store()?.getItem(IMP_KEY);
            if (raw) for (const k of JSON.parse(raw) as string[]) seen.add(String(k));
        } catch { /* ignorar */ }
        return seen;
    }

    function persistSeen() {
        try {
            const arr = Array.from(seenSet()).slice(-300);
            store()?.setItem(IMP_KEY, JSON.stringify(arr));
        } catch { /* ignorar */ }
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

    function track(type: ClientEventType, restaurantId: string, opts: { surface?: ClientSurface; position?: number } = {}): void {
        try {
            if (!restaurantId || deps.now() < pausedUntil) return;
            if (queue.length >= MAX_QUEUE) queue.shift();
            const ev: QueuedEvent = { restaurantId, type, sessionId: sessionId() };
            if (opts.surface) ev.surface = opts.surface;
            if (typeof opts.position === 'number' && opts.position >= 0 && opts.position <= 999) ev.position = Math.floor(opts.position);
            queue.push(ev);
            if (queue.length >= MAX_BATCH) void flush(false); else schedule();
        } catch { /* nunca afectar la pantalla */ }
    }

    /** Una impresión por sesión, local y superficie. Devuelve true si se registró. */
    function impression(restaurantId: string, surface: ClientSurface, position?: number): boolean {
        try {
            const key = `${restaurantId}|${surface}`;
            const s = seenSet();
            if (s.has(key)) return false;
            s.add(key);
            persistSeen();
            track('impression', restaurantId, { surface, position });
            return true;
        } catch { return false; }
    }

    return { track, impression, flush, sessionId, _queue: () => queue };
}

// ───────────── instancia del navegador ─────────────

let browser: ReturnType<typeof createTracker> | null = null;

function getBrowserTracker() {
    if (browser || typeof window === 'undefined') return browser;
    let storage: TrackerDeps['storage'] = null;
    try { storage = window.sessionStorage; } catch { storage = null; }

    browser = createTracker({
        send: async (body, beacon) => {
            try {
                if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
                    return navigator.sendBeacon('/api/client-events', new Blob([body], { type: 'application/json' })) ? 202 : 0;
                }
                const res = await fetch('/api/client-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' });
                return res.status;
            } catch { return 0; }
        },
        now: () => Date.now(),
        newId: () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(36).slice(2)}`),
        storage,
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (t) => window.clearTimeout(t as number),
    });

    const onHide = () => { if (document.visibilityState === 'hidden') void browser?.flush(true); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', () => void browser?.flush(true));
    return browser;
}

export function trackClientEvent(type: ClientEventType, restaurantId: string, opts?: { surface?: ClientSurface; position?: number }): void {
    try { getBrowserTracker()?.track(type, restaurantId, opts); } catch { /* ignorar */ }
}

export function trackImpression(restaurantId: string, surface: ClientSurface, position?: number): void {
    try { getBrowserTracker()?.impression(restaurantId, surface, position); } catch { /* ignorar */ }
}
