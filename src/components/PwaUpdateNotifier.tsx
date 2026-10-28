'use client';

import { useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { watchForPwaUpdate } from '@/lib/pwa/update-watcher';

const TOAST_ID = 'pwa-update';

/** Avisa "Hay una versión nueva" con un botón para recargar. No recarga solo. */
export function PwaUpdateNotifier() {
    useEffect(() => {
        return watchForPwaUpdate(() => {
            toast(
                (t) => (
                    <span className="flex items-center gap-3 text-sm">
                        <span>Hay una versión nueva de Almuerzo.cl.</span>
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="font-bold text-primary underline underline-offset-2"
                        >
                            Actualizar
                        </button>
                        <button type="button" onClick={() => toast.dismiss(t.id)} aria-label="Cerrar" className="text-muted-foreground">
                            ✕
                        </button>
                    </span>
                ),
                { id: TOAST_ID, duration: Infinity }
            );
        });
    }, []);

    return null;
}
