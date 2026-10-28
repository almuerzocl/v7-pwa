/**
 * Detecta que se instaló una versión nueva de la PWA mientras la pantalla sigue abierta.
 *
 * El service worker (src/app/sw.ts) usa skipWaiting + clientsClaim: la versión nueva toma el control
 * sola, pero la página ya cargada sigue con el JavaScript anterior hasta recargar. Por eso avisamos
 * (sin recargar a la fuerza: el usuario puede estar a mitad de una reserva).
 *
 * `controllerchange` también se dispara en la PRIMERA instalación (de sin controlador a con
 * controlador); ahí no hay versión previa y no se avisa.
 */

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export interface UpdateWatcherDeps {
    serviceWorker: ServiceWorkerContainer;
    document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
}

/** Devuelve la función que deja de observar. `onUpdate` se llama una sola vez. */
export function watchForPwaUpdate(onUpdate: () => void, deps?: Partial<UpdateWatcherDeps>): () => void {
    const sw = deps?.serviceWorker ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
    if (!sw) return () => {};
    const doc = deps?.document ?? document;
    const setIv = deps?.setInterval ?? setInterval;
    const clearIv = deps?.clearInterval ?? clearInterval;

    const hadController = !!sw.controller;
    let notified = false;

    const onControllerChange = () => {
        if (!hadController || notified) return;
        notified = true;
        onUpdate();
    };
    sw.addEventListener('controllerchange', onControllerChange);

    // Una PWA instalada puede quedar abierta días sin navegar: sin esto el navegador no busca versiones nuevas.
    const checkForUpdate = () => {
        sw.getRegistration().then((reg) => reg?.update()).catch(() => {});
    };
    const onVisibility = () => {
        if (doc.visibilityState === 'visible') checkForUpdate();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    const timer = setIv(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);

    return () => {
        sw.removeEventListener('controllerchange', onControllerChange);
        doc.removeEventListener('visibilitychange', onVisibility);
        clearIv(timer);
    };
}
