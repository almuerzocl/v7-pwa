'use client';

import { useEffect } from 'react';
import toast from 'react-hot-toast';

/**
 * Listens for online/offline events and replays queued POST requests
 * when the connection is restored. Also listens for SW messages about
 * queue replay status.
 */
export function useOfflineSync() {
    useEffect(() => {
        const handleOnline = () => {
            // Tell SW to replay queued requests
            if (navigator.serviceWorker?.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'REPLAY_OFFLINE_QUEUE' });
                toast.loading('Reconectado. Sincronizando acciones pendientes...', { id: 'offline-sync', duration: 3000 });
            }
        };

        const handleMessage = (event: MessageEvent) => {
            if (event.data?.type === 'OFFLINE_QUEUE_REPLAYED') {
                const { replayed, remaining } = event.data;
                if (replayed > 0 && remaining === 0) {
                    toast.success(`${replayed} acción(es) sincronizada(s) exitosamente`, { id: 'offline-sync' });
                } else if (replayed > 0 && remaining > 0) {
                    toast.error(`${replayed} sincronizada(s), ${remaining} pendiente(s)`, { id: 'offline-sync' });
                }
            }
        };

        window.addEventListener('online', handleOnline);
        navigator.serviceWorker?.addEventListener('message', handleMessage);

        return () => {
            window.removeEventListener('online', handleOnline);
            navigator.serviceWorker?.removeEventListener('message', handleMessage);
        };
    }, []);
}
