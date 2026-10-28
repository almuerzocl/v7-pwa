"use client";

import { displayReputation } from "@/lib/elite";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useAuth } from "@/context/AuthContext";
import { ShoppingBag, MapPin, Clock, CheckCircle, XCircle, Star, X, ArrowLeft } from "lucide-react";
import { toast } from "react-hot-toast";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import {
    getBusinessStatusStyles,
    formatCurrency,
    getBusinessStatusLabel,
    formatReputation,
} from "@/lib/core-business/ui-helpers";
import { useRouter, usePathname } from "next/navigation";
import { fetchUserOrdersAction } from "@/app/actions/takeaway-actions";
import { transitionStatusAction } from "@/app/actions/status-actions";
import { cancelTakeawayOrderAction } from "@/app/actions/cancel-takeaway-action";
import { TicketFrame } from "@/components/TicketFrame";

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL = new Set([
    "ENTREGADO", "COMPLETADA", "COMPLETADO",
    "CANCELADA", "CANCELADO",
    "RECHAZADA", "RECHAZADO",
    "NO_RETIRADO", "NO RETIRADO",
]);
const GOOD_END = new Set(["ENTREGADO", "COMPLETADA", "COMPLETADO"]);
const BAD_END  = new Set(["NO_RETIRADO", "NO RETIRADO", "RECHAZADA", "RECHAZADO"]);

type ViewFilter = "active" | "history";

function classify(order: any): "active" | "history" {
    return TERMINAL.has((order.status || "").toUpperCase()) ? "history" : "active";
}

function formatAddress(address: any): string {
    if (!address) return "";
    if (typeof address === "string") return address;
    if (typeof address === "object")
        return `${address.street || ""} ${address.number || ""}`.trim();
    return String(address);
}

// ─── Order Modal ──────────────────────────────────────────────────────────────

function OrderModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
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
                <TicketFrame src={`/orders/${orderId}`} title="Detalle del Pedido" />
            </div>
        </div>
    );
}

// ─── Order Row ────────────────────────────────────────────────────────────────

function OrderRow({
    order,
    index,
    userId,
    viewFilter,
    onStatusChange,
    onOpenOrder,
}: {
    order: any;
    index: number;
    userId: string;
    viewFilter: ViewFilter;
    onStatusChange: (id: string, newStatus: string) => void;
    onOpenOrder: (id: string) => void;
}) {
    const status = (order.status || "PENDIENTE").toUpperCase();

    const [cancelling,    setCancelling]    = useState(false);
    const [confirming,    setConfirming]    = useState(false);
    const [confirmCancel, setConfirmCancel] = useState(false);

    // ── Row background
    let rowBg = index % 2 === 0 ? "bg-white" : "bg-stone-50";
    if (viewFilter === "history") {
        if (GOOD_END.has(status))     rowBg = "bg-green-50";
        else if (BAD_END.has(status)) rowBg = "bg-red-50";
    }

    // ── Action availability
    const isWorkedOn = ["PREPARANDO", "LISTO"].includes(status); // solo desde la preparación penaliza
    const canCancel  = viewFilter === "active" && ["PENDIENTE", "CREADA", "APROBADA", "PREPARANDO", "LISTO"].includes(status);
    const canConfirm = viewFilter === "active" && status === "LISTO";

    // ── Handlers
    const doCancel = async () => {
        setCancelling(true);
        setConfirmCancel(false);
        const result = await cancelTakeawayOrderAction(order.id, userId);
        setCancelling(false);
        if (!result.success) { toast.error(result.error || "Error al cancelar"); return; }
        onStatusChange(order.id, result.newStatus as string);
        result.impactsReputation
            ? toast.error("Pedido cancelado. El restaurante ya trabajaba en él — afecta reputación.", { duration: 5000 })
            : toast.success("Pedido cancelado sin impacto en reputación.");
    };

    const handleCancel = () => { isWorkedOn ? setConfirmCancel(true) : doCancel(); };

    const handleConfirmDelivery = async () => {
        setConfirming(true);
        const result = await transitionStatusAction("takeaway_orders", order.id, "ENTREGADO", userId);
        setConfirming(false);
        if (!result.success) { toast.error(result.error || "Error al confirmar recepción"); return; }
        onStatusChange(order.id, "ENTREGADO");
        toast.success("¡Recepción confirmada!");
    };

    const hasActions = canConfirm || canCancel;

    return (
        <>
            <div className={`flex rounded-2xl border border-border/40 overflow-hidden transition-shadow hover:shadow-sm ${rowBg}`}>
                {/* 2/3 — Card info */}
                <div
                    className="flex-[2] min-w-0 p-4 cursor-pointer select-none active:opacity-80"
                    onClick={() => onOpenOrder(order.id)}
                >
                    <div className="flex items-start justify-between gap-2 mb-2">
                        <h3 className="font-bold text-sm leading-tight">
                            {order.restaurant?.name || "Restaurante"}
                        </h3>
                        <span className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full border ${getBusinessStatusStyles(order.status)}`}>
                            {getBusinessStatusLabel(order.status, "TAKEAWAY")}
                        </span>
                    </div>

                    {order.restaurant?.address && (
                        <p className="flex items-center gap-1 text-[11px] text-muted-foreground mb-2.5 truncate">
                            <MapPin className="w-3 h-3 shrink-0" />
                            <span className="truncate">{formatAddress(order.restaurant.address)}</span>
                        </p>
                    )}

                    <div className="flex flex-wrap gap-3 text-[11px] font-medium text-foreground/70">
                        <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-primary" />
                            {order.created_at
                                ? format(new Date(order.created_at), "d MMM, HH:mm", { locale: es })
                                : "—"}
                        </span>
                        <span className="font-extrabold text-foreground/90">
                            {formatCurrency(order.total_amount)}
                        </span>
                    </div>
                </div>

                {/* 1/3 — Actions */}
                <div className="flex-[1] min-w-[88px] max-w-[110px] border-l border-border/30 p-2 flex flex-col gap-1.5 justify-center items-stretch">
                    {canConfirm && (
                        <button
                            onClick={handleConfirmDelivery}
                            disabled={confirming}
                            className="text-[9px] font-bold px-2 py-2 rounded-xl bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors flex flex-col items-center gap-0.5 disabled:opacity-50"
                        >
                            <CheckCircle className="w-4 h-4" />
                            {confirming ? "..." : "Recibido"}
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

            {/* Cancel confirmation */}
            {confirmCancel && (
                <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-6">
                    <div className="bg-card rounded-3xl p-6 max-w-xs w-full shadow-2xl space-y-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="bg-rose-100 p-2.5 rounded-2xl">
                                <XCircle className="w-5 h-5 text-rose-600" />
                            </div>
                            <p className="font-black text-foreground text-sm">Cancelar Pedido</p>
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                            El restaurante ya está trabajando en tu pedido. Cancelar ahora afectará tu reputación. ¿Continuar?
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                            <Button variant="outline" className="rounded-xl h-11 font-bold" onClick={() => setConfirmCancel(false)}>
                                No
                            </Button>
                            <Button className="rounded-xl h-11 font-bold bg-rose-600 hover:bg-rose-700 text-white" onClick={doCancel}>
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

export default function OrdersPage() {
    const { user, profile, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!authLoading && !user) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        }
    }, [user, authLoading, router, pathname]);

    const [orders,    setOrders]    = useState<any[]>([]);
    const [loading,   setLoading]   = useState(true);
    const [view,      setView]      = useState<ViewFilter>("active");
    const [modalId,   setModalId]   = useState<string | null>(null);

    const fetchOrders = useCallback(async () => {
        if (!user) return;
        setLoading(true);
        try {
            const result = await fetchUserOrdersAction(user.id);
            if (result.success) {
                setOrders(
                    [...result.orders].sort(
                        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                    )
                );
            }
        } catch (e) {
            console.error("Error loading orders:", e);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        if (authLoading) return;
        if (!user) { setLoading(false); return; }
        fetchOrders();
    }, [user, authLoading, fetchOrders]);

    const handleStatusChange = useCallback((id: string, newStatus: string) => {
        setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o)));
    }, []);

    const filtered = useMemo(
        () => orders.filter((o) => classify(o) === view),
        [orders, view]
    );

    const reputation = displayReputation(profile, 'takeaway');

    if (authLoading || !user) return null;

    const emptyMessage =
        view === "active" ? "No tienes pedidos en curso." : "Sin historial de pedidos.";

    return (
        <div className="w-full max-w-lg mx-auto px-4 pt-4 pb-32 space-y-3">
            {/* ── Header ──────────────────────────────────────────── */}
            <header className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                    <button onClick={() => router.back()} className="p-1.5 rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <h1 className="text-2xl font-black tracking-tight text-foreground">Mis Pedidos</h1>
                </div>
                {reputation !== null && (
                    <span className="bg-green-100 text-green-700 text-[10px] font-bold px-3 py-1.5 rounded-full border border-green-200 flex items-center gap-1.5">
                        <Star className="w-3 h-3 fill-green-500 text-green-500" />
                        {formatReputation(reputation)}
                    </span>
                )}
            </header>

            {/* ── Toggle: En curso / Historial ─────────────────────── */}
            <div className="flex bg-muted/50 rounded-2xl p-1 gap-0.5">
                {(["active", "history"] as ViewFilter[]).map((v) => (
                    <button
                        key={v}
                        onClick={() => setView(v)}
                        className={`flex-1 py-2 rounded-xl text-[11px] font-bold transition-all ${
                            view === v
                                ? "bg-background shadow-sm text-foreground"
                                : "text-muted-foreground hover:text-foreground/70"
                        }`}
                    >
                        {v === "active" ? "En curso" : "Historial"}
                    </button>
                ))}
            </div>

            {/* ── Content ─────────────────────────────────────────── */}
            {loading || authLoading ? (
                <div className="space-y-2 pt-1">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-[80px] bg-muted/40 animate-pulse rounded-2xl" />
                    ))}
                </div>
            ) : filtered.length === 0 ? (
                <div className="py-14 text-center space-y-2 bg-muted/20 rounded-3xl border border-dashed border-border mt-2">
                    <ShoppingBag className="w-9 h-9 text-muted-foreground/30 mx-auto" />
                    <p className="text-sm text-muted-foreground font-medium">{emptyMessage}</p>
                </div>
            ) : (
                <div className="space-y-2 pt-1">
                    {filtered.map((order, i) => (
                        <OrderRow
                            key={order.id}
                            order={order}
                            index={i}
                            userId={user!.id}
                            viewFilter={view}
                            onStatusChange={handleStatusChange}
                            onOpenOrder={setModalId}
                        />
                    ))}
                </div>
            )}

            {/* ── Modal ───────────────────────────────────────────── */}
            {modalId && (
                <OrderModal orderId={modalId} onClose={() => setModalId(null)} />
            )}
        </div>
    );
}
