import { describe, expect, it, vi } from 'vitest';
import { UPDATE_CHECK_INTERVAL_MS, watchForPwaUpdate, type UpdateWatcherDeps } from '../src/lib/pwa/update-watcher';

function setup(controller: object | null) {
    const swListeners = new Map<string, () => void>();
    const docListeners = new Map<string, () => void>();
    const update = vi.fn().mockResolvedValue(undefined);
    const sw = {
        controller,
        addEventListener: (e: string, fn: () => void) => swListeners.set(e, fn),
        removeEventListener: (e: string) => swListeners.delete(e),
        getRegistration: vi.fn().mockResolvedValue({ update }),
    };
    const doc = {
        visibilityState: 'visible' as DocumentVisibilityState,
        addEventListener: (e: string, fn: () => void) => docListeners.set(e, fn),
        removeEventListener: (e: string) => docListeners.delete(e),
    };
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const deps: Partial<UpdateWatcherDeps> = {
        serviceWorker: sw as unknown as ServiceWorkerContainer,
        document: doc as unknown as UpdateWatcherDeps['document'],
        setInterval: ((fn: () => void, ms: number) => (timers.push({ fn, ms }), timers.length)) as unknown as typeof setInterval,
        clearInterval: vi.fn() as unknown as typeof clearInterval,
    };
    return { deps, swListeners, docListeners, update, sw, doc, timers };
}

describe('watchForPwaUpdate', () => {
    it('avisa una sola vez cuando cambia el controlador de uno ya existente', () => {
        const { deps, swListeners } = setup({});
        const onUpdate = vi.fn();
        watchForPwaUpdate(onUpdate, deps);
        swListeners.get('controllerchange')!();
        swListeners.get('controllerchange')!();
        expect(onUpdate).toHaveBeenCalledTimes(1);
    });

    it('no avisa en la primera instalación (sin controlador previo)', () => {
        const { deps, swListeners } = setup(null);
        const onUpdate = vi.fn();
        watchForPwaUpdate(onUpdate, deps);
        swListeners.get('controllerchange')!();
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('busca versión nueva al volver a la pestaña y cada 30 min', async () => {
        const { deps, docListeners, update, timers } = setup({});
        watchForPwaUpdate(vi.fn(), deps);
        docListeners.get('visibilitychange')!();
        await Promise.resolve(); await Promise.resolve();
        expect(update).toHaveBeenCalledTimes(1);
        expect(timers[0].ms).toBe(UPDATE_CHECK_INTERVAL_MS);
        timers[0].fn();
        await Promise.resolve(); await Promise.resolve();
        expect(update).toHaveBeenCalledTimes(2);
    });

    it('no busca cuando la pestaña queda oculta', async () => {
        const { deps, docListeners, update, doc } = setup({});
        watchForPwaUpdate(vi.fn(), deps);
        doc.visibilityState = 'hidden';
        docListeners.get('visibilitychange')!();
        await Promise.resolve();
        expect(update).not.toHaveBeenCalled();
    });

    it('la función de limpieza quita los listeners', () => {
        const { deps, swListeners, docListeners } = setup({});
        const stop = watchForPwaUpdate(vi.fn(), deps);
        stop();
        expect(swListeners.size).toBe(0);
        expect(docListeners.size).toBe(0);
        expect(deps.clearInterval).toHaveBeenCalled();
    });

    it('sin service worker (navegador sin soporte) no hace nada ni lanza', () => {
        const stop = watchForPwaUpdate(vi.fn(), { serviceWorker: undefined as unknown as ServiceWorkerContainer });
        expect(() => stop()).not.toThrow();
    });
});
