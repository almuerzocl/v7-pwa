import { describe, it, expect, vi } from 'vitest';
import { createPlatformTracker, FLUSH_MS, MAX_BATCH, MAX_QUEUE, PAUSE_MS, type PlatformTrackerDeps } from '@/lib/platform-events';

const RID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';

function setup(over: Partial<PlatformTrackerDeps> & { status?: number } = {}) {
    let now = 1_000_000;
    const sent: Array<{ body: any; beacon: boolean }> = [];
    const timers: Array<() => void> = [];
    const store = new Map<string, string>();
    const deps: PlatformTrackerDeps = {
        send: async (body, beacon) => { sent.push({ body: JSON.parse(body), beacon }); return over.status ?? 200; },
        now: () => now,
        newId: () => 'abcd-1234-efgh-5678',
        storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
        setTimer: fn => { timers.push(fn); return timers.length; },
        clearTimer: () => {},
        env: () => ({ platform: 'ios', standalone: true }),
        ...over,
    };
    const tracker = createPlatformTracker(deps);
    return { tracker, sent, timers, store, advance: (ms: number) => { now += ms; } };
}

describe('createPlatformTracker', () => {
    it('encola con sesión, plataforma y datos limpios, y los envía en un lote al vencer el temporizador', async () => {
        const { tracker, sent, timers } = setup();
        tracker.track('discount_view', { discountId: DID.toUpperCase(), restaurantId: RID, step: 'cart', props: { kind: 'order', junk: 'x' } as any });
        expect(sent).toHaveLength(0);
        expect(timers).toHaveLength(1);
        timers[0]();
        await Promise.resolve(); await Promise.resolve();
        expect(sent).toHaveLength(1);
        expect(sent[0].beacon).toBe(false);
        expect(sent[0].body.events).toEqual([{ type: 'discount_view', sessionId: 'abcd-1234-efgh-5678', platform: 'ios', standalone: true, step: 'cart', restaurantId: RID, discountId: DID, props: { kind: 'order' } }]);
    });

    it('descarta ids y pasos con forma inválida en vez de enviarlos', () => {
        const { tracker } = setup();
        tracker.track('ticket_view', { refId: 'no-es-uuid', step: 'Paso Uno' });
        const ev = tracker._queue()[0];
        expect(ev.refId).toBeUndefined();
        expect(ev.step).toBeUndefined();
    });

    it('"once" registra una sola vez por combinación y lo recuerda en la sesión', () => {
        const a = setup();
        expect(a.tracker.track('discount_view', { discountId: DID, step: 'cart', once: true })).toBe(true);
        expect(a.tracker.track('discount_view', { discountId: DID, step: 'cart', once: true })).toBe(false);
        expect(a.tracker.track('discount_view', { discountId: DID, step: 'wizard', once: true })).toBe(true); // otro paso
        expect(a.tracker._queue()).toHaveLength(2);
        // Una instancia nueva con el mismo almacenamiento de sesión (recarga de la página) lo sigue recordando.
        const b = createPlatformTracker({
            send: async () => 200, now: () => 1, newId: () => 'otro-id-12345', setTimer: () => 0, clearTimer: () => {},
            storage: { getItem: k => a.store.get(k) ?? null, setItem: () => {} }, env: () => ({ platform: 'ios' }),
        });
        expect(b.track('discount_view', { discountId: DID, step: 'cart', once: true })).toBe(false);
    });

    it('sin "once" registra cada vez', () => {
        const { tracker } = setup();
        tracker.track('cancel_start'); tracker.track('cancel_start');
        expect(tracker._queue()).toHaveLength(2);
    });

    it('al llegar a MAX_BATCH envía de inmediato', async () => {
        const { tracker, sent } = setup();
        for (let i = 0; i < MAX_BATCH; i++) tracker.track('checkout_step', { step: `paso:${i}` });
        await Promise.resolve(); await Promise.resolve();
        expect(sent).toHaveLength(1);
        expect(sent[0].body.events).toHaveLength(MAX_BATCH);
    });

    it('la cola tiene tope: se descartan los más antiguos', () => {
        const { tracker } = setup({ send: () => new Promise(() => {}) }); // el envío nunca termina
        for (let i = 0; i < MAX_QUEUE + 30; i++) tracker.track('checkout_step', { step: `paso:${i}` });
        expect(tracker._queue().length).toBeLessThanOrEqual(MAX_QUEUE);
    });

    it('con 401 se pausa el envío y se descarta lo pendiente; pasado el tiempo vuelve a funcionar', async () => {
        const { tracker, sent, advance } = setup({ status: 401 });
        tracker.track('login');
        await tracker.flush(false);
        expect(sent).toHaveLength(1);
        expect(tracker.track('login')).toBe(false); // pausado
        advance(PAUSE_MS + 1);
        expect(tracker.track('login')).toBe(true);
    });

    it('al cerrar la página envía con sendBeacon (beacon = true)', async () => {
        const { tracker, sent } = setup();
        tracker.track('session_start');
        await tracker.flush(true);
        expect(sent[0].beacon).toBe(true);
    });

    it('NUNCA lanza: ni si el envío falla, ni si el almacenamiento falla, ni si el entorno falla', async () => {
        const { tracker } = setup({
            send: async () => { throw new Error('red caída'); },
            storage: { getItem: () => { throw new Error('sin storage'); }, setItem: () => { throw new Error('sin storage'); } },
        });
        expect(() => tracker.track('login', { once: true })).not.toThrow();
        await expect(tracker.flush(false)).resolves.toBeUndefined();

        const broken = createPlatformTracker({
            send: async () => 200, now: () => 1, newId: () => { throw new Error('sin crypto'); }, setTimer: () => 0, clearTimer: () => {},
            env: () => { throw new Error('sin navigator'); },
        });
        expect(() => broken.track('login')).not.toThrow();
        expect(broken.track('login')).toBe(false);
    });

    it('el temporizador de envío es el esperado', () => {
        expect(FLUSH_MS).toBe(4000);
        expect(vi.isMockFunction(setup)).toBe(false);
    });
});
