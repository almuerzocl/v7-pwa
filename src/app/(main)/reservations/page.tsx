"use client";

import { displayReputation } from "@/lib/elite";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { format, startOfDay, addDays } from "date-fns";
import { es } from "date-fns/locale";
import {
    Calendar, MapPin, Users, Clock, X,
    CheckCircle2, XCircle, CalendarPlus, Star, ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "react-hot-toast";
import { cancelReservationAction } from "@/app/actions/cancel-reservation-action";
import { listMyReservationsAction } from "@/app/actions/my-tickets-actions";
import {
    formatReputation,
    getBusinessStatusLabel,
    getBusinessStatusStyles,
} from "@/lib/core-business/ui-helpers";
import { TICKET_URL } from "@/lib/config";
import { TicketFrame } from "@/components/TicketFrame";

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL = new Set([
    "COMPLETADA", "COMPLETADO",
    "CANCELADA", "CANCELADO",
    "RECHAZADA", "RECHAZADO",
    "NO SHOW", "NO_SHOW",
]);
const GOOD_END = new Set(["COMPLETADA", "COMPLETADO"]);
const BAD_END  = new Set(["NO SHOW", "NO_SHOW", "RECHAZADA", "RECHAZADO"]);

type ViewFilter = "today" | "future" | "expired";
type RoleFilter = "all" | "organizer" | "guest";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatAddress(address: any): string {
    if (!address) return "";
    if (typeof address === "string") return address;
    if (typeof address === "object")
        return `${address.street || ""} ${address.number || ""}${
            address.commune ? `, ${address.commune}` : ""
        }`.trim();
    return String(address);
}

function classify(res: any): "today" | "future" | "expired" {
    const status = (res.status || "").toUpperCase();
    if (TERMINAL.has(status)) return "expired";
    const dt  = new Date(res.date_time);
    const now = startOfDay(new Date());
    if (dt < now)              return "expired";
    if (dt >= addDays(now, 1)) return "future";
    return "today";
}

function buildCalendarUrl(res: any): string {
    const start = new Date(res.date_time);
    const end   = new Date(start.getTime() + 90 * 60 * 1000);
    const fmt   = (d: Date) =>
        d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const name   = res.restaurant?.name || "Restaurante";
    const link   = `${TICKET_URL}/r/${res.unique_code}`;
    const addr   = formatAddress(res.restaurant?.address);
    const params = new URLSearchParams({
        action:   "TEMPLATE",
        text:     `Reserva en ${name}`,
        dates:    `${fmt(start)}/${fmt(end)}`,
        details:  `Reserva en ${name}.\n\nVer ticket: ${link}`,
        location: addr || name,
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

const calKey = (id: string) => `cal-added-${id}`;

// Merge two reservation arrays, dedup by id, sort newest-first
function mergeReservations(a: any[], b: any[]): any[] {
    const seen = new Set<string>();
    return [...a, ...b]
        .filter((r) => { if (seen.has(r.id)) return false; seen.add(r.id); return true; })
        .sort((x, y) => new Date(y.date_time).getTime() - new Date(x.date_time).getTime());
}

// ─── Ticket Modal ─────────────────────────────────────────────────────────────

function TicketModal({ code, onClose }: { code: string; onClose: () => void }) {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-[9000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={onClose}
        >
            <div
                className="relative bg-background rounded-3xl overflow-hidden w-full max-w-sm h-[88vh] shadow-2xl ring-1 ring-border/30"
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    onClick={onClose}
                    className="absolute top-3 right-3 z-10 bg-background/90 backdrop-blur-sm rounded-full p-1.5 shadow-md border border-border/50 hover:bg-muted transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
                <TicketFrame src={`${TICKET_URL}/r/${code}`} title="Ticket de Reserva" ticket={{ kind: "r", code }} />
            </div>
        </div>
    );
}

// ─── Reservation Row ──────────────────────────────────────────────────────────

function ReservationRow({
    res,
    index,
    userId,
    viewFilter,
    onStatusChange,
    onOpenTicket,
}: {
    res: any;
    index: number;
    userId: string;
    viewFilter: ViewFilter;
    onStatusChange: (id: string, newStatus: string) => void;
    onOpenTicket: (code: string) => void;
}) {
    const status      = (res.status || "PENDIENTE").toUpperCase();
    const isOrganizer = res.organizer_id === userId;

    const [calAdded,      setCalAdded]      = useState(false);
    const [checkingIn,    setCheckingIn]    = useState(false);
    const [cancelling,    setCancelling]    = useState(false);
    const [confirmCancel, setConfirmCancel] = useState(false);

    useEffect(() => {
        setCalAdded(!!localStorage.getItem(calKey(res.id)));
    }, [res.id]);

    let rowBg = index % 2 === 0 ? "bg-white" : "bg-stone-50";
    if (viewFilter === "expired") {
        if (GOOD_END.has(status))      rowBg = "bg-green-50";
        else if (BAD_END.has(status))  rowBg = "bg-red-50";
    }

    const handleCalendar = () => {
        window.open(buildCalendarUrl(res), "_blank", "noopener,noreferrer");
        localStorage.setItem(calKey(res.id), "1");
        setCalAdded(true);
        toast.success("Abierto en Google Calendar");
    };

    const handleCheckIn = async () => {
        setCheckingIn(true);
        const { error } = await supabase
            .from("reservations")
            .update({
                status: "CHECK-IN CLIENTE",
                timestamps: {
                    ...(res.timestamps || {}),
                    checkin_at: new Date().toISOString(),
                },
            })
            .eq("id", res.id);
        setCheckingIn(false);
        if (error) { toast.error("No se pudo registrar la llegada"); return; }
        onStatusChange(res.id, "CHECK-IN CLIENTE");
        toast.success("¡Llegada confirmada!");
    };

    const doCancel = async () => {
        setCancelling(true);
        setConfirmCancel(false);
        const result = await cancelReservationAction(res.id, userId);
        setCancelling(false);
        if (!result.success) {
            toast.error(result.error || "Error al cancelar");
            return;
        }
        onStatusChange(res.id, result.newStatus as string);
        result.impactsReputation
            ? toast.error("Cancelación tardía — afecta reputación", { duration: 5000 })
            : toast.success("Reserva cancelada sin impacto en reputación");
    };

    const handleCancel = () => {
        const msUntil = new Date(res.date_time).getTime() - Date.now();
        msUntil <= 60 * 60 * 1000 ? setConfirmCancel(true) : doCancel();
    };

    const isExpiredView = viewFilter === "expired";
    const canCheckIn  = isOrganizer && !isExpiredView && (status === "CONFIRMADA" || status === "PENDIENTE");
    const canCancel   = isOrganizer && !isExpiredView && (status === "PENDIENTE" || status === "CONFIRMADA");
    const canCalendar = !calAdded && !isExpiredView;
    const hasActions  = canCalendar || canCheckIn || canCancel;

    return (
        <>
            <div
                className={`flex rounded-2xl border border-border/40 overflow-hidden transition-shadow hover:shadow-sm ${rowBg}`}
            >
                {/* Card info */}
                <div
                    className="flex-[2] min-w-0 p-4 cursor-pointer select-none active:opacity-80"
                    onClick={() => onOpenTicket(res.unique_code || res.id)}
                >
                    <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="min-w-0">
                            <h3 className="font-bold text-sm leading-tight truncate">
                                {res.restaurant?.name || "Restaurante"}
                            </h3>
                            {!isOrganizer && (
                                <span className="text-[10px] text-primary font-semibold">Soy invitado</span>
                            )}
                        </div>
                        <span
                            className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full border ${getBusinessStatusStyles(res.status)}`}
                        >
                            {getBusinessStatusLabel(res.status, "RESERVATION")}
                        </span>
                    </div>

                    {res.restaurant?.address && (
                        <p className="flex items-center gap-1 text-[11px] text-muted-foreground mb-2.5 truncate">
                            <MapPin className="w-3 h-3 shrink-0" />
                            <span className="truncate">{formatAddress(res.restaurant.address)}</span>
                        </p>
                    )}

                    <div className="flex flex-wrap gap-3 text-[11px] font-medium text-foreground/70">
                        <span className="flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-primary" />
                            {res.date_time
                                ? format(new Date(res.date_time), "EEE d MMM", { locale: es })
                                : "—"}
                        </span>
                        <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-primary" />
                            {res.date_time
                                ? format(new Date(res.date_time), "HH:mm")
                                : "—"}
                        </span>
                        <span className="flex items-center gap-1">
                            <Users className="w-3.5 h-3.5 text-primary" />
                            {res.party_size || 1}p
                        </span>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex-[1] min-w-[88px] max-w-[110px] border-l border-border/30 p-2 flex flex-col gap-1.5 justify-center items-stretch">
                    {canCalendar && (
                        <button
                            onClick={handleCalendar}
                            className="text-[9px] font-bold px-2 py-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/20 transition-colors flex flex-col items-center gap-0.5"
                        >
                            <CalendarPlus className="w-4 h-4" />
                            Calendario
                        </button>
                    )}
                    {canCheckIn && (
                        <button
                            onClick={handleCheckIn}
                            disabled={checkingIn}
                            className="text-[9px] font-bold px-2 py-2 rounded-xl bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors flex flex-col items-center gap-0.5 disabled:opacity-50"
                        >
                            <CheckCircle2 className="w-4 h-4" />
                            {checkingIn ? "..." : "Check-in"}
                        </button>
                    )}
                    {canCancel && (
                        <button
                            onClick={handleCancel}
                            disabled={cancelling}
                            className="text-[9px] font-bold px-2 py-2 rounded-xl bg-rose-50 text-rose-600 hover:bg-rose-100 transition-colors flex flex-col items-center gap-0.5 disabled:opacity-50"
                        >
                            <XCircle className="w-4 h-4" />
                            {cancelling ? "..." : "Cancelar"}
                        </button>
                    )}
                    {!hasActions && (
                        <span className="text-[9px] text-muted-foreground text-center">—</span>
                    )}
                </div>
            </div>

            {/* Late-cancel confirmation */}
            {confirmCancel && (
                <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-6">
                    <div className="bg-card rounded-3xl p-6 max-w-xs w-full shadow-2xl space-y-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="bg-rose-100 p-2.5 rounded-2xl">
                                <XCircle className="w-5 h-5 text-rose-600" />
                            </div>
                            <p className="font-black text-foreground text-sm">Cancelar Reserva</p>
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                            Cancelar con menos de 1 hora de anticipación afectará tu reputación. ¿Continuar?
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                            <Button
                                variant="outline"
                                className="rounded-xl h-11 font-bold"
                                onClick={() => setConfirmCancel(false)}
                            >
                                No
                            </Button>
                            <Button
                                className="rounded-xl h-11 font-bold bg-rose-600 hover:bg-rose-700 text-white"
                                onClick={doCancel}
                            >
                                Sí, cancelar
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ReservationsPage() {
    const { user, profile, isLoading: authLoading } = useAuth();
    const router   = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!authLoading && !user) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        }
    }, [user, authLoading, router, pathname]);

    const [orgReservations,   setOrgReservations]   = useState<any[]>([]);
    const [guestReservations, setGuestReservations] = useState<any[]>([]);
    const [loading,           setLoading]           = useState(true);
    const [fetchError,        setFetchError]        = useState<string | null>(null);
    const [view,              setView]              = useState<ViewFilter>("today");
    const [role,              setRole]              = useState<RoleFilter>("all");
    const [modalCode,         setModalCode]         = useState<string | null>(null);
    const autoViewSet = useRef(false);

    // Stable primitives — avoids re-creating fetchAll on every auth token refresh
    const userId    = user?.id;

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const fetchAll = useCallback(async () => {
        if (!userId) return;
        setLoading(true);
        setFetchError(null);
        try {
            // Lectura en el servidor (sesión validada con auth.getUser()): organizador + invitado por
            // user_id, email o teléfono del perfil. También enlaza el user_id del invitado (backfill).
            const result = await listMyReservationsAction();
            if (result.error) throw new Error("No se pudieron cargar las reservas.");

            const sortDesc = (arr: any[]) =>
                [...arr].sort((a, b) => new Date(b.date_time).getTime() - new Date(a.date_time).getTime());

            setOrgReservations(sortDesc(result.organizer));
            setGuestReservations(sortDesc(result.guest));
        } catch (e: any) {
            console.error("Error loading reservations:", e);
            setFetchError(e?.message || "No se pudieron cargar las reservas.");
        } finally {
            setLoading(false);
        }
    }, [userId]);

    // Re-fetch when user identity or contact info changes (not on every token refresh)
    useEffect(() => {
        if (authLoading) return;
        if (!userId) { setLoading(false); return; }
        autoViewSet.current = false;
        fetchAll();
    }, [userId, authLoading, fetchAll]);

    // After data loads, auto-select the first view tab that has reservations
    useEffect(() => {
        if (loading || autoViewSet.current) return;
        autoViewSet.current = true;
        const source = role === "all"
            ? mergeReservations(orgReservations, guestReservations)
            : role === "organizer" ? orgReservations : guestReservations;
        if (source.some((r) => classify(r) === view)) return;
        for (const v of ["today", "future", "expired"] as ViewFilter[]) {
            if (source.some((r) => classify(r) === v)) { setView(v); return; }
        }
    }, [loading, orgReservations, guestReservations, role, view]);

    const handleStatusChange = useCallback((id: string, newStatus: string) => {
        setOrgReservations((prev) =>
            prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r))
        );
        setGuestReservations((prev) =>
            prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r))
        );
    }, []);

    const filtered = useMemo(() => {
        const source = role === "all"
            ? mergeReservations(orgReservations, guestReservations)
            : role === "organizer" ? orgReservations : guestReservations;
        return source.filter((r) => classify(r) === view);
    }, [orgReservations, guestReservations, view, role]);

    const viewCounts = useMemo(() => {
        const source = role === "all"
            ? mergeReservations(orgReservations, guestReservations)
            : role === "organizer" ? orgReservations : guestReservations;
        return {
            today:   source.filter((r) => classify(r) === "today").length,
            future:  source.filter((r) => classify(r) === "future").length,
            expired: source.filter((r) => classify(r) === "expired").length,
        };
    }, [orgReservations, guestReservations, role]);

    const reputation = displayReputation(profile, 'reservation');

    const emptyMessage =
        view === "today"
            ? "No tienes reservas para hoy."
            : view === "future"
            ? "No tienes reservas futuras."
            : "Sin historial de reservas.";

    return (
        <div className="w-full max-w-lg mx-auto px-4 pt-4 pb-32 space-y-3">
            {/* Header */}
            <header className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                    <button onClick={() => router.back()} className="p-1.5 rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <h1 className="text-2xl font-black tracking-tight text-foreground">
                        Mis Reservas
                    </h1>
                </div>
                {reputation !== null && (
                    <span className="bg-green-100 text-green-700 text-[10px] font-bold px-3 py-1.5 rounded-full border border-green-200 flex items-center gap-1.5">
                        <Star className="w-3 h-3 fill-green-500 text-green-500" />
                        {formatReputation(reputation)}
                    </span>
                )}
            </header>

            {/* Toggle 1: Hoy / Futuras / Históricas */}
            <div className="flex bg-muted/50 rounded-2xl p-1 gap-0.5">
                {(["today", "future", "expired"] as ViewFilter[]).map((v) => {
                    const count = viewCounts[v];
                    const label = v === "today" ? "Hoy" : v === "future" ? "Futuras" : "Históricas";
                    return (
                        <button
                            key={v}
                            onClick={() => setView(v)}
                            className={`flex-1 py-2 rounded-xl text-[11px] font-bold transition-all flex items-center justify-center gap-1 ${
                                view === v
                                    ? "bg-background shadow-sm text-foreground"
                                    : "text-muted-foreground hover:text-foreground/70"
                            }`}
                        >
                            {label}
                            {!loading && count > 0 && (
                                <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${
                                    view === v ? "bg-primary text-white" : "bg-muted-foreground/20 text-muted-foreground"
                                }`}>
                                    {count}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Toggle 2: Todas / Organizador / Invitado */}
            <div className="flex bg-muted/50 rounded-2xl p-1 gap-0.5">
                {(["all", "organizer", "guest"] as RoleFilter[]).map((r) => (
                    <button
                        key={r}
                        onClick={() => setRole(r)}
                        className={`flex-1 py-2 rounded-xl text-[11px] font-bold transition-all ${
                            role === r
                                ? "bg-background shadow-sm text-foreground"
                                : "text-muted-foreground hover:text-foreground/70"
                        }`}
                    >
                        {r === "all" ? "Todas" : r === "organizer" ? "Organizador" : "Invitado"}
                    </button>
                ))}
            </div>

            {/* Fetch error */}
            {fetchError && !loading && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 flex items-center justify-between gap-3">
                    <p className="text-xs font-bold text-rose-700 flex-1">{fetchError}</p>
                    <button
                        onClick={fetchAll}
                        className="text-[11px] font-black text-rose-600 underline underline-offset-2 shrink-0"
                    >
                        Reintentar
                    </button>
                </div>
            )}

            {/* Content */}
            {loading || authLoading || !user ? (
                <div className="space-y-2 pt-1">
                    {[1, 2, 3].map((i) => (
                        <div
                            key={i}
                            className="h-[88px] bg-muted/40 animate-pulse rounded-2xl"
                        />
                    ))}
                </div>
            ) : filtered.length === 0 ? (
                <div className="py-14 text-center space-y-2 bg-muted/20 rounded-3xl border border-dashed border-border mt-2">
                    <Calendar className="w-9 h-9 text-muted-foreground/30 mx-auto" />
                    <p className="text-sm text-muted-foreground font-medium">
                        {emptyMessage}
                    </p>
                </div>
            ) : (
                <div className="space-y-2 pt-1">
                    {filtered.map((res, i) => (
                        <ReservationRow
                            key={res.id}
                            res={res}
                            index={i}
                            userId={user!.id}
                            viewFilter={view}
                            onStatusChange={handleStatusChange}
                            onOpenTicket={setModalCode}
                        />
                    ))}
                </div>
            )}

            {/* Ticket Modal */}
            {modalCode && (
                <TicketModal code={modalCode} onClose={() => setModalCode(null)} />
            )}
        </div>
    );
}
