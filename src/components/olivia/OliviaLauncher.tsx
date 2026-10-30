"use client";

// OlivIA: ícono en la portada + panel de conversación. Solo recomienda: pedir y reservar se hace desde la ficha del local.
// La lógica (tope, clima, datos) vive en el servidor (/api/olivia); aquí solo se conversa y se muestra lo que responde.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MapPin, Send, X } from "lucide-react";
import { useLocation } from "@/context/LocationContext";
import { getOliviaStatusAction, type OliviaStatus } from "@/app/actions/olivia-usage-action";
import type { OliviaRecommendation } from "@/lib/olivia/chat";

type Msg =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; recommendations: OliviaRecommendation[]; needsLocation: boolean }
    | { role: "notice"; content: string };

const SUGGESTIONS = ["¿Qué hay con terraza hoy?", "Algo rico y no muy caro", "Tengo ganas de algo calentito"];
const MAX_CHARS = 400;

export function OliviaLauncher({ initialStatus = null }: { initialStatus?: OliviaStatus | null } = {}) {
    const { lat, lng } = useLocation();
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<OliviaStatus | null>(initialStatus);
    const [messages, setMessages] = useState<Msg[]>([]);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
    const launcherRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const logRef = useRef<HTMLDivElement>(null);

    // El origen lo pone la persona: la dirección elegida en el encabezado, o su ubicación si la compartió aquí.
    const origin = lat != null && lng != null ? { lat, lng } : gps;
    const remaining = status?.remaining ?? null;
    const exhausted = remaining === 0;

    useEffect(() => {
        if (!open || status) return;
        getOliviaStatusAction().then(r => r.status && setStatus(r.status));
    }, [open, status]);

    const close = useCallback(() => {
        setOpen(false);
        launcherRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!open) return;
        inputRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { e.stopPropagation(); close(); return; }
            if (e.key !== "Tab" || !panelRef.current) return;
            const f = panelRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled])');
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [open, close]);

    useEffect(() => {
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
    }, [messages, busy]);

    const send = async (raw: string) => {
        const content = raw.trim().slice(0, MAX_CHARS);
        if (!content || busy || exhausted) return;
        const history = [...messages.filter((m): m is Exclude<Msg, { role: "notice" }> => m.role !== "notice"), { role: "user" as const, content }];
        setMessages(m => [...m, { role: "user", content }]);
        setText("");
        setBusy(true);
        try {
            const res = await fetch("/api/olivia", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: history.map(h => ({ role: h.role, content: h.content })), location: origin ?? undefined }),
            });
            const data = await res.json().catch(() => ({}));
            if (data?.usage) setStatus(s => (s ? { ...s, ...data.usage } : s));
            if (res.ok) {
                setMessages(m => [...m, { role: "assistant", content: data.reply, recommendations: data.recommendations ?? [], needsLocation: !!data.needsLocation }]);
            } else {
                if (data?.code === "limit_reached") setStatus(s => (s ? { ...s, remaining: 0 } : s));
                setMessages(m => [...m, { role: "notice", content: data?.error || "OlivIA no pudo responder ahora. Intenta de nuevo en un momento." }]);
            }
        } catch {
            setMessages(m => [...m, { role: "notice", content: "No pude conectarme. Revisa tu conexión e intenta de nuevo." }]);
        } finally {
            setBusy(false);
        }
    };

    const shareLocation = () => {
        if (!navigator.geolocation) {
            setMessages(m => [...m, { role: "notice", content: "Tu dispositivo no permite compartir la ubicación. Puedes escribir tu dirección en la parte de arriba de la pantalla." }]);
            return;
        }
        navigator.geolocation.getCurrentPosition(
            pos => {
                setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                setMessages(m => [...m, { role: "notice", content: "Listo, ya tengo tu ubicación. Vuelve a enviar tu pregunta para que la use." }]);
            },
            () => setMessages(m => [...m, { role: "notice", content: "No pude acceder a tu ubicación. Puedes escribir tu dirección en la parte de arriba de la pantalla y preguntarme de nuevo." }]),
            { timeout: 8000, maximumAge: 5 * 60 * 1000 },
        );
    };

    return (
        <>
            <button
                ref={launcherRef}
                type="button"
                onClick={() => setOpen(true)}
                aria-label="Hablar con OlivIA, asistente de inteligencia artificial para tu almuerzo"
                aria-haspopup="dialog"
                className="fixed right-3 top-[calc(env(safe-area-inset-top,0px)+72px)] z-[900] flex flex-col items-center gap-1 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:scale-95 transition-transform"
            >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/olivia.svg" alt="" width={48} height={48} className="h-12 w-12 rounded-full shadow-md ring-2 ring-white" />
                <span className="text-xs font-black leading-none text-zinc-900">OlivIA</span>
                <span className="rounded-full bg-zinc-900 px-2 py-1 text-xs font-bold leading-none text-white">Asistente IA</span>
            </button>

            {open && (
                <>
                    <div className="fixed inset-0 z-[20001] bg-black/40" onClick={close} aria-hidden="true" />
                    <div
                        ref={panelRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="olivia-title"
                        className="fixed inset-x-0 bottom-0 z-[20002] mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white shadow-2xl sm:bottom-4 sm:rounded-3xl"
                        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
                    >
                        <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src="/images/olivia.svg" alt="" width={48} height={48} className="h-12 w-12 rounded-full" />
                            <div className="min-w-0 flex-1">
                                <h2 id="olivia-title" className="text-base font-black leading-tight text-zinc-900">OlivIA</h2>
                                <p className="text-xs font-medium text-zinc-600">Asistente IA de almuerzo</p>
                            </div>
                            <button type="button" onClick={close} aria-label="Cerrar OlivIA" className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-700 hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div ref={logRef} role="log" aria-live="polite" className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                            {messages.length === 0 && (
                                <div className="space-y-3 text-sm text-zinc-800">
                                    <p>¡Hola! Te ayudo a decidir dónde y qué almorzar entre los restaurantes de almuerzo.cl: platos, precios, terraza, qué te queda cerca y qué te acomoda según el día.</p>
                                    <p className="text-xs text-zinc-600">Yo te muestro los locales; pedir o reservar lo haces tú desde su ficha. No tengo datos de ocupación en vivo y no puedo confirmar alergias: eso se consulta al restaurante.</p>
                                    <div className="flex flex-wrap gap-2 pt-1">
                                        {SUGGESTIONS.map(s => (
                                            <button key={s} type="button" disabled={busy || exhausted} onClick={() => send(s)}
                                                className="min-h-[44px] rounded-full border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
                                                {s}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {messages.map((m, i) =>
                                m.role === "user" ? (
                                    <div key={i} className="flex justify-end">
                                        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-900 px-4 py-2.5 text-sm text-white">{m.content}</p>
                                    </div>
                                ) : m.role === "notice" ? (
                                    <p key={i} className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">{m.content}</p>
                                ) : (
                                    <div key={i} className="space-y-2">
                                        <p className="max-w-[90%] whitespace-pre-line rounded-2xl rounded-bl-md bg-zinc-100 px-4 py-2.5 text-sm text-zinc-900">{m.content}</p>
                                        {m.needsLocation && !origin && (
                                            <button type="button" onClick={shareLocation} className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                                                <MapPin className="h-4 w-4" /> Compartir mi ubicación
                                            </button>
                                        )}
                                        {m.recommendations.map(r => (
                                            <Link key={r.id} href={r.href} onClick={close}
                                                className="block rounded-2xl border border-zinc-200 bg-white p-3 hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                                                <span className="flex items-baseline justify-between gap-2">
                                                    <span className="text-sm font-extrabold text-zinc-900">{r.name}</span>
                                                    <span className="shrink-0 text-xs font-medium text-zinc-600">{[r.comuna, r.distanceKm != null ? `${r.distanceKm.toString().replace(".", ",")} km` : ""].filter(Boolean).join(" · ")}</span>
                                                </span>
                                                {r.reason && <span className="mt-1 block text-sm text-zinc-800">{r.reason}</span>}
                                                <span className="mt-2 inline-flex min-h-[44px] items-center text-sm font-bold text-primary underline underline-offset-4">Ver local para {r.canOrder && r.canReserve ? "pedir o reservar" : r.canOrder ? "pedir" : r.canReserve ? "reservar" : "ver detalles"}</span>
                                            </Link>
                                        ))}
                                    </div>
                                ),
                            )}

                            {busy && <p className="text-sm text-zinc-600" aria-live="polite">OlivIA está pensando…</p>}
                        </div>

                        <div className="border-t border-zinc-100 px-4 pb-3 pt-2">
                            <p className="mb-2 text-xs font-semibold text-zinc-700" aria-live="polite">
                                {status == null
                                    ? " "
                                    : exhausted
                                        ? `Usaste tus ${status.daily_limit} consultas de hoy. Vuelven mañana.`
                                        : `Te ${remaining === 1 ? "queda" : "quedan"} ${remaining} de ${status.daily_limit} consultas hoy`}
                            </p>
                            {exhausted ? (
                                <button type="button" onClick={close} className="min-h-[48px] w-full rounded-2xl bg-primary px-4 text-sm font-extrabold text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900">
                                    Seguir buscando restaurantes y menús
                                </button>
                            ) : (
                                <form onSubmit={e => { e.preventDefault(); send(text); }} className="flex items-center gap-2">
                                    <label htmlFor="olivia-input" className="sr-only">Escribe tu consulta para OlivIA</label>
                                    <input
                                        id="olivia-input"
                                        ref={inputRef}
                                        value={text}
                                        onChange={e => setText(e.target.value)}
                                        maxLength={MAX_CHARS}
                                        disabled={busy}
                                        placeholder="Ej: algo con terraza y no muy caro"
                                        autoComplete="off"
                                        className="h-12 min-w-0 flex-1 rounded-2xl border border-zinc-300 bg-white px-4 text-base text-zinc-900 placeholder:text-zinc-500 focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
                                    />
                                    <button type="submit" disabled={busy || !text.trim()} aria-label="Enviar consulta"
                                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 disabled:opacity-50">
                                        <Send className="h-5 w-5" />
                                    </button>
                                </form>
                            )}
                        </div>
                    </div>
                </>
            )}
        </>
    );
}
