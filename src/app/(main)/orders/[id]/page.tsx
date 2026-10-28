"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, Suspense } from "react";
import { trackPlatformEvent } from "@/lib/platform-events";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "react-hot-toast";
import { supabase } from "@/lib/supabase";
import { formatCurrency, getBusinessStatusLabel } from "@/lib/core-business/ui-helpers";
import { ArrowLeft, MapPin, ShoppingBag, Clock, ChevronRight, CheckCircle2, Package, UtensilsCrossed, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { TicketDigital } from "@/components/TicketDigital";
import { useAuth } from "@/context/AuthContext";
import { cancelTakeawayOrderAction } from "@/app/actions/cancel-takeaway-action";
import { getOrderForViewerAction } from "@/app/actions/my-tickets-actions";

export default function OrderDetailPage() {
    return (
        <Suspense>
            <OrderDetailPageContent />
        </Suspense>
    );
}

function OrderDetailPageContent() {
    const params = useParams();
    const router = useRouter();
    const { user } = useAuth();
    const [order, setOrder] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const searchParams = useSearchParams();
    const [performingAction, setPerformingAction] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);

    useEffect(() => {
        if (params.id) {
            fetchOrder().then((data) => {
                if (data && searchParams.get('action') === 'pickup') {
                    handlePickup(data);
                }
            });
        }
    }, [params.id]);

    const handlePickup = async (currentOrder: any) => {
        if (currentOrder.status === 'ENTREGADO' || currentOrder.status === 'COMPLETADO') {
            toast.success("Este pedido ya ha sido retirado");
            return;
        }

        setPerformingAction(true);
        try {
            const { error } = await supabase
                .from('takeaway_orders')
                .update({ 
                    status: 'ENTREGADO',
                    timestamps: {
                        ...(currentOrder.timestamps || {}),
                        picked_up_at: new Date().toISOString()
                    }
                })
                .eq('id', currentOrder.id);

            if (error) throw error;
            toast.success("¡Llegada notificada! El personal te entregará tu pedido en breve.");
        } catch (err) {
            console.error("Pickup error:", err);
            toast.error("No se pudo notificar tu llegada. Por favor, avisa al personal.");
        } finally {
            setPerformingAction(false);
            // Remove action from URL
            router.replace(`/orders/${params.id}`);
        }
    };

    const fetchOrder = async () => {
        setLoading(true);
        setError(null);
        try {
            const { data, error: fetchError } = await getOrderForViewerAction(params.id as string);

            if (fetchError || !data) {
                console.error("Fetch error:", fetchError);
                setError("No pudimos encontrar tu pedido. Verifica el código o intenta nuevamente.");
                return;
            }

            setOrder(data);
            trackPlatformEvent("ticket_view", { refId: data.id, props: { kind: "order" }, once: true });
            
            if (data?.id) {
                subscribeToChanges(data.id);
            }
            return data;
        } catch (err: any) {
            console.error("Catch error:", err);
            setError("Ocurrió un problema al cargar el pedido.");
            return null;
        } finally {
            setLoading(false);
        }
    };

    const subscribeToChanges = (realId: string) => {
        const channel = supabase
            .channel(`order-${realId}`)
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'takeaway_orders', filter: `id=eq.${realId}` },
                (payload) => {
                    setOrder((prev: any) => ({ ...prev, ...payload.new }));
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    };

    const CANCELLABLE = ['CREADA', 'PENDIENTE', 'APROBADA', 'PREPARANDO', 'LISTO'];
    const canCancel = order && user?.id === order.user_id && CANCELLABLE.includes(order.status);

    const handleCancelRequest = () => {
        if (!order) return;
        trackPlatformEvent("cancel_start", { refId: order.id, props: { kind: "order" } });
        const isBeingWorkedOn = ['PREPARANDO', 'LISTO'].includes(order.status);
        if (isBeingWorkedOn) {
            setShowCancelConfirm(true);
        } else {
            performCancel();
        }
    };

    const performCancel = async () => {
        if (!order || !user) return;
        setCancelling(true);
        setShowCancelConfirm(false);
        try {
            const result = await cancelTakeawayOrderAction(order.id, user.id);
            if (!result.success) {
                toast.error(result.error || 'Error al cancelar el pedido');
                return;
            }
            if (result.impactsReputation) {
                toast.error("Pedido cancelado. Dado que el restaurante ya estaba preparando su orden, esto afecta su reputación.", {
                    duration: 5000, icon: "⚠️",
                    style: { borderRadius: '1rem', background: '#333', color: '#fff' }
                });
            } else {
                toast.success("Su pedido fue cancelado exitosamente sin impacto en su reputación.", {
                    duration: 4000, icon: "✓",
                    style: { borderRadius: '1rem', background: '#333', color: '#fff' }
                });
            }
        } catch (err) {
            toast.error('Error al cancelar el pedido');
        } finally {
            setCancelling(false);
        }
    };

    if (loading) return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="font-bold text-muted-foreground animate-pulse">Cargando pedido...</p>
        </div>
    );

    if (error || !order) return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center space-y-6">
            <div className="bg-amber-50 p-6 rounded-[2rem] border border-amber-100 space-y-4">
                <UtensilsCrossed className="w-12 h-12 text-amber-500 mx-auto" />
                <h2 className="text-xl font-black text-amber-900">{error || "Pedido no encontrado"}</h2>
                <p className="text-sm text-amber-700/80 font-medium">Verifica el historial de pedidos en la aplicación.</p>
            </div>
            <Button onClick={() => router.push('/orders')} variant="outline" className="rounded-2xl h-12 px-8 font-bold">
                Volver a Mis Pedidos
            </Button>
        </div>
    );
    return (
        <div className="w-full max-w-lg mx-auto p-4 space-y-6 pb-24">
            <header className="flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => router.back()} className="rounded-full">
                    <ArrowLeft className="w-5 h-5" />
                </Button>
                <h1 className="text-xl font-black tracking-tight">Detalle del Pedido</h1>
            </header>

            <TicketDigital res={order} showActions={false} />

            <div className="space-y-4">
                <Button
                    className="w-full h-16 bg-foreground text-background rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-foreground/5 hover:bg-foreground/90 transition-all active:scale-[0.98]"
                    onClick={() => {
                        const restaurantPhone = order.restaurant?.whatsapp_phone || order.restaurant?.phone;
                        if (restaurantPhone) window.open(`tel:${restaurantPhone}`);
                    }}
                >
                    Llamar al Restaurante
                </Button>

                {canCancel && (
                    <Button
                        variant="ghost"
                        onClick={handleCancelRequest}
                        disabled={cancelling}
                        className="w-full text-rose-500 hover:text-rose-600 hover:bg-rose-50 rounded-xl font-bold py-5 text-[11px] uppercase tracking-widest border border-rose-100"
                    >
                        {cancelling ? (
                            <span className="flex items-center gap-2">
                                <div className="w-4 h-4 border-2 border-rose-400 border-t-transparent rounded-full animate-spin" />
                                Cancelando...
                            </span>
                        ) : (
                            <span className="flex items-center gap-2">
                                <XCircle className="w-4 h-4" />
                                Cancelar Pedido
                            </span>
                        )}
                    </Button>
                )}

                <Button
                    onClick={() => router.push('/')}
                    variant="ghost"
                    className="w-full h-14 rounded-2xl font-black text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                    Volver al Inicio
                </Button>
            </div>

            {/* Late cancellation confirmation dialog */}
            {showCancelConfirm && (
                <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-6 animate-in fade-in duration-200">
                    <div className="bg-card rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-5 animate-in zoom-in-95 duration-200">
                        <div className="flex items-center gap-3">
                            <div className="bg-rose-100 p-3 rounded-2xl">
                                <XCircle className="w-6 h-6 text-rose-600" />
                            </div>
                            <h3 className="font-black text-lg text-foreground">Cancelar Pedido</h3>
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                            El restaurante ya está trabajando en tu pedido. Si cancelas ahora, podría afectar tu reputación. ¿Estás seguro?
                        </p>
                        <div className="grid grid-cols-2 gap-3 pt-2">
                            <Button variant="outline" className="rounded-xl h-12 font-bold" onClick={() => setShowCancelConfirm(false)}>
                                No
                            </Button>
                            <Button className="rounded-xl h-12 font-bold bg-rose-600 hover:bg-rose-700 text-white" onClick={performCancel}>
                                Sí, cancelar
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
