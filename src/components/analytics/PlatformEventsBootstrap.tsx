"use client";

import { useEffect } from "react";
import { trackPlatformEvent } from "@/lib/platform-events";

/**
 * Registra el inicio de la sesión de la app y la instalación de la PWA. No pinta nada.
 * `session_start` y los avisos de instalación se emiten una sola vez por sesión (el tracker lo impone, y la base también).
 * Solo se monta dentro de (main), es decir, con sesión iniciada.
 */
export function PlatformEventsBootstrap() {
    useEffect(() => {
        trackPlatformEvent("session_start", { once: true });

        // El navegador avisa que la app es instalable / que se instaló. Son avisos pasivos: no se muestra ni se cambia nada.
        const onPrompt = () => trackPlatformEvent("pwa_install_prompt", { once: true });
        const onInstalled = () => trackPlatformEvent("pwa_installed", { once: true });
        window.addEventListener("beforeinstallprompt", onPrompt);
        window.addEventListener("appinstalled", onInstalled);
        return () => {
            window.removeEventListener("beforeinstallprompt", onPrompt);
            window.removeEventListener("appinstalled", onInstalled);
        };
    }, []);

    return null;
}
