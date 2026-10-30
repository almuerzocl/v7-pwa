"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

// Aviso visible cuando el teléfono pierde la red. Solo informa; no cambia ningún flujo.
export function ConnectionNotice() {
    const [online, setOnline] = useState(true);

    useEffect(() => {
        const sync = () => setOnline(navigator.onLine);
        sync();
        window.addEventListener("online", sync);
        window.addEventListener("offline", sync);
        return () => {
            window.removeEventListener("online", sync);
            window.removeEventListener("offline", sync);
        };
    }, []);

    if (online) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="fixed top-0 inset-x-0 z-[30000] flex items-center justify-center gap-2 bg-zinc-900 px-4 py-2 text-xs font-bold text-white"
        >
            <WifiOff className="h-4 w-4" aria-hidden="true" />
            Sin conexión. Reintentaremos cuando vuelva la señal.
        </div>
    );
}
