"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";

const LOAD_TIMEOUT_MS = 10000;

/**
 * Iframe de ficha digital con estado de carga que nunca queda colgado en silencio:
 * spinner hasta el onLoad; si no carga en 10 s o falla, mensaje con "Reintentar"
 * y enlace "Abrir en pestaña nueva".
 */
export function TicketFrame({ src, title, ticket }: { src: string; title: string; ticket?: { kind: "r" | "o"; code: string } }) {
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [attempt, setAttempt] = useState(0);
    // Con `ticket`, el iframe no se monta hasta saber si hay token (si no, cargaría anónimo y gastaría cupo).
    // El token (60 s, un solo uso) va en el fragmento (#vt=), nunca en la query; cada intento pide uno nuevo.
    const [frameSrc, setFrameSrc] = useState<string | null>(ticket ? null : src);

    useEffect(() => {
        if (!ticket) { setFrameSrc(src); return; }
        let active = true;
        setFrameSrc(null);
        fetch("/api/ticket-viewer-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify(ticket),
        })
            .then((r) => (r.ok ? r.json() : { token: null }))
            .catch(() => ({ token: null }))
            .then((b: { token?: string | null }) => {
                if (active) setFrameSrc(b?.token ? `${src}#vt=${b.token}` : src);
            });
        return () => { active = false; };
    }, [src, attempt, ticket?.kind, ticket?.code]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        setStatus("loading");
        const t = setTimeout(() => {
            setStatus((s) => {
                if (s === "loading") console.error("[TicketFrame] timeout cargando", src);
                return s === "loading" ? "error" : s;
            });
        }, LOAD_TIMEOUT_MS);
        return () => clearTimeout(t);
    }, [src, attempt]);

    return (
        <>
            {(status === "loading" || !frameSrc) && (
                <div className="absolute inset-0 flex items-center justify-center bg-background">
                    <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
                </div>
            )}
            {status === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-8 text-center">
                    <AlertCircle className="w-10 h-10 text-red-500" />
                    <p className="text-sm font-bold">No pudimos cargar la ficha</p>
                    <button
                        onClick={() => setAttempt((n) => n + 1)}
                        className="h-11 px-6 rounded-2xl bg-orange-500 text-white text-xs font-black uppercase tracking-widest"
                    >
                        Reintentar
                    </button>
                    <a href={src} target="_blank" rel="noopener noreferrer" className="text-xs font-bold underline text-muted-foreground">
                        Abrir en pestaña nueva
                    </a>
                </div>
            )}
            {frameSrc && <iframe
                key={attempt}
                src={frameSrc}
                title={title}
                className="w-full h-full border-0"
                onLoad={() => setStatus((s) => (s === "loading" ? "ready" : s))}
                onError={() => { console.error("[TicketFrame] error de red", src); setStatus("error"); }}
            />}
        </>
    );
}
