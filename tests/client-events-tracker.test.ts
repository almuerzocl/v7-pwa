import { describe, it, expect, vi } from 'vitest';
import { createTracker, FLUSH_MS, MAX_BATCH, MAX_QUEUE, PAUSE_MS, type TrackerDeps } from '../src/lib/client-events';

const RID = '11111111-1111-4111-8111-111111111111';
const RID2 = '22222222-2222-4222-8222-222222222222';

function setup(opts: { status?: number; storage?: boolean; sendThrows?: boolean } = {}) {
    let t = 1_000_000;
    const timers: { fn: () => void; at: number; id: number }[] = [];
    let nextId = 1;
    const sent: { body: any; beacon: boolean }[] = [];
    const mem = new Map<string, string>();
    const deps: TrackerDeps = {
        send: vi.fn(async (body, beacon) => {
            if (opts.sendThrows) throw new Error('offline');
            sent.push({ body: JSON.parse(body), beacon });
            return opts.status ?? 200;
        }),
        now: () => t,
        newId: () => `abcd1234-ef56-7890-abcd-${nextId++}`.padEnd(36, '0'),
        storage: opts.storage === false ? null : { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) },
        setTimer: (fn, ms) => { const id = nextId++; timers.push({ fn, at: t + ms, id }); return id; },
        clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    };
    const advance = async (ms: number) => {
        t += ms;
        for (const x of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(x), 1); x.fn(); }
        await new Promise((r) => setTimeout(r, 0));
    };
    return { tracker: createTracker(deps), deps, sent, advance, mem, timers, tick: (ms: number) => { t += ms; } };
}

describe('tracker de eventos de cliente', () => {
    it('agrupa los eventos y los envía a los 4 s en un solo lote', async () => {
        const { tracker, sent, advance } = setup();
        tracker.track('profile_view', RID, { surface: 'detail' });
        tracker.track('menu_view', RID, { surface: 'menu' });
        expect(sent).toHaveLength(0);
        await advance(FLUSH_MS);
        expect(sent).toHaveLength(1);
        expect(sent[0].body.events.map((e: any) => e.type)).toEqual(['profile_view', 'menu_view']);
        expect(sent[0].beacon).toBe(false);
    });

    it('al juntar 20 eventos envía sin esperar', async () => {
        const { tracker, sent } = setup();
        for (let i = 0; i < MAX_BATCH; i++) tracker.track('share', RID);
        await new Promise((r) => setTimeout(r, 0));
        expect(sent).toHaveLength(1);
        expect(sent[0].body.events).toHaveLength(MAX_BATCH);
    });

    it('al cerrar la pestaña (beacon) envía lo pendiente de inmediato', async () => {
        const { tracker, sent } = setup();
        tracker.track('call', RID, { surface: 'detail' });
        await tracker.flush(true);
        expect(sent).toHaveLength(1);
        expect(sent[0].beacon).toBe(true);
    });

    it('una impresión se registra una sola vez por sesión, local y superficie', () => {
        const { tracker } = setup();
        expect(tracker.impression(RID, 'home', 0)).toBe(true);
        expect(tracker.impression(RID, 'home', 3)).toBe(false);
        expect(tracker.impression(RID, 'favorites', 0)).toBe(true);
        expect(tracker.impression(RID2, 'home', 1)).toBe(true);
        expect(tracker._queue()).toHaveLength(3);
    });

    it('la deduplicación sobrevive a un nuevo tracker en la misma sesión (misma pestaña)', () => {
        const a = setup();
        a.tracker.impression(RID, 'home', 0);
        const b = createTracker({ ...a.deps });
        expect(b.impression(RID, 'home', 0)).toBe(false);
    });

    it('la sesión es estable y tiene un formato aceptado por el servidor', () => {
        const { tracker, mem } = setup();
        const s = tracker.sessionId();
        expect(s).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        expect(tracker.sessionId()).toBe(s);
        expect(mem.get('almuerzo:ev:sid')).toBe(s);
    });

    it('sin almacenamiento igual funciona (modo privado)', async () => {
        const { tracker, sent, advance } = setup({ storage: false });
        tracker.impression(RID, 'home', 0);
        await advance(FLUSH_MS);
        expect(sent).toHaveLength(1);
    });

    it('descarta posiciones fuera de rango y evita enviar eventos sin local', () => {
        const { tracker } = setup();
        tracker.track('impression', RID, { surface: 'home', position: 5000 });
        tracker.track('impression', '', { surface: 'home' });
        const q = tracker._queue();
        expect(q).toHaveLength(1);
        expect(q[0].position).toBeUndefined();
    });

    it('con 401 (sin sesión) pausa el envío y descarta lo pendiente, sin reintentar en bucle', async () => {
        const { tracker, sent, advance, deps } = setup({ status: 401 });
        tracker.track('profile_view', RID);
        await advance(FLUSH_MS);
        expect(sent).toHaveLength(1);
        tracker.track('profile_view', RID);
        await advance(FLUSH_MS);
        expect(sent).toHaveLength(1);                       // pausado
        expect(tracker._queue()).toHaveLength(0);
        await advance(PAUSE_MS);
        tracker.track('profile_view', RID);
        await advance(FLUSH_MS);
        expect(deps.send).toHaveBeenCalledTimes(2);         // pasada la pausa vuelve a intentar
    });

    it('un error de red no rompe nada ni se propaga', async () => {
        const { tracker, advance } = setup({ sendThrows: true });
        tracker.track('menu_view', RID);
        await expect(advance(FLUSH_MS)).resolves.toBeUndefined();
    });

    it('la cola tiene tope: si se acumula, se descartan los más viejos', () => {
        const { tracker, deps } = setup();
        (deps.send as any).mockImplementation(() => new Promise(() => {}));   // el envío nunca termina
        for (let i = 0; i < MAX_QUEUE + 30; i++) tracker.track('share', RID, { position: i % 900 });
        expect(tracker._queue().length).toBeLessThanOrEqual(MAX_QUEUE);
    });
});
