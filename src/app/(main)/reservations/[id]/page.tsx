"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, Suspense } from "react";
import { trackPlatformEvent } from "@/lib/platform-events";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "react-hot-toast";
import { supabase } from "@/lib/supabase";
import { getBusinessStatusIcon, getBusinessStatusStyles, getBusinessStatusLabel } from "@/lib/core-business/ui-helpers";
import { ArrowLeft, MapPin, Calendar, Clock, Users, Ticket, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useNotifications } from "@/context/NotificationContext";
import { useAuth } from "@/context/AuthContext";
import { cancelReservationAction } from "@/app/actions/cancel-reservation-action";
import { getReservationForViewerAction } from "@/app/actions/my-tickets-actions";

import { TicketDigital } from "@/components/TicketDigital";

export default function ReservationDetailPage() {
    return (
        <Suspense>
            <ReservationDetailPageContent />
        </Suspense>
    );
}

function ReservationDetailPageContent() {
    const params = useParams();
    const router = useRouter();
    const { user } = useAuth();
    const [reservation, setReservation] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [cancelling, setCancelling] = useState(false);

    const searchParams = useSearchParams();
    const [performingAction, setPerformingAction] = useState(false);

    useEffect(() => {
        if (params.id) {
            fetchReservation().then((data) => {
                if (data && searchParams.get('action') === 'checkin') {
                    handleCheckIn(data);
                }
            });
        }
    }, [params.id]);

    const handleCheckIn = async (currentRes: any) => {
        if (currentRes.status === 'CHECK-IN CLIENTE' || currentRes.status === 'COMPLETADO') {
            toast.success("Ya has realizado el check-in");
            return;
        }

        setPerformingAction(true);
        try {
            const { error } = await supabase
                .from('reservations')
                .update({ 
                    status: 'CHECK-IN CLIENTE',
                    timestamps: {
                        ...(currentRes.timestamps || {}),
                        arrived_at: new Date().toISOString(),
                        checkin_at: new Date().toISOString()
                    }
                })
                .eq('id', currentRes.id);

            if (error) throw error;
            toast.success("¡Llegada confirmada! Por favor, espera a ser atendido.");
        } catch (err) {
            console.error("Check-in error:", err);
            toast.error("No se pudo realizar el check-in. Por favor, avisa al personal.");
        } finally {
            setPerformingAction(false);
            // Remove action from URL to avoid re-triggering
            router.replace(`/reservations/${params.id}`);
        }
    };

    const fetchReservation = async () => {
        setLoading(true);
        setError(null);
        try {
            const { data, error: fetchError } = await getReservationForViewerAction(params.id as string);

            if (fetchError || !data) {
                console.error("Fetch error:", fetchError);
                setError("No pudimos encontrar tu reserva. Verifica el código o intenta nuevamente.");
                return;
            }

            setReservation(data);
            trackPlatformEvent("ticket_view", { refId: data.id, props: { kind: "reservation" }, once: true });
            
            // Start subscription with the actual UUID
            if (data?.id) {
                subscribeToChanges(data.id);
            }
            return data;
        } catch (err: any) {
            console.error("Catch error:", err);
            setError("Ocurrió un problema al cargar la reserva.");
            return null;
        } finally {
            setLoading(false);
        }
    };

    const subscribeToChanges = (realId: string) => {
        const channel = supabase
            .channel(`reservation-${realId}`)
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'reservations', filter: `id=eq.${realId}` },
                (payload) => {
                    setReservation((prev: any) => ({ ...prev, ...payload.new }));
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    };

    const CANCELLABLE = ['CREADA', 'PENDIENTE', 'CONFIRMADA'];
    const isOrganizer = user?.id && reservation?.organizer_id === user.id;
    const canCancel = isOrganizer && reservation && CANCELLABLE.includes(reservation.status);

    const handleCancelRequest = () => {
        if (!reservation || !user) return;
        trackPlatformEvent("cancel_start", { refId: reservation.id, props: { kind: "reservation" } });
        const msUntil = new Date(reservation.date_time).getTime() - Date.now();
        if (msUntil <= 60 * 60 * 1000) {
            setShowCancelConfirm(true);
        } else {
            performCancel();
        }
    };

    const performCancel = async () => {
        if (!reservation || !user) return;
        setCancelling(true);
        setShowCancelConfirm(false);
        try {
            const result = await cancelReservationAction(reservation.id, user.id);
            if (!result.success) {
                toast.error(result.error || "No se pudo cancelar la reserva");
                return;
            }
            if (result.impactsReputation) {
                toast("Reserva cancelada. Como fue con menos de 1 hora de anticipación, cuenta en tu reputación.", {
                    duration: 8000, icon: "⚠️",
                    style: { borderRadius: '1rem', background: '#333', color: '#fff' }
                });
            } else {
                toast.success("Reserva cancelada. Cancelaste con tiempo, así que no afecta tu reputación.", {
                    duration: 8000, icon: "✓",
                    style: { borderRadius: '1rem', background: '#333', color: '#fff' }
                });
            }
        } catch (err) {
            toast.error("Error al cancelar la reserva");
        } finally {
            setCancelling(false);
        }
    };

    if (loading) return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="font-bold text-muted-foreground animate-pulse">Cargando ticket digital...</p>
        </div>
    );

    if (error || !reservation) return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center space-y-6">
            <div className="bg-red-50 p-6 rounded-[2rem] border border-red-100 space-y-4">
                <XCircle className="w-12 h-12 text-red-500 mx-auto" />
                <h2 className="text-xl font-black text-red-900">{error || "Ticket no encontrado"}</h2>
                <p className="text-sm text-red-700/80 font-medium">Si el problema persiste, contacta al restaurante o a soporte.</p>
            </div>
            <Button onClick={() => router.push('/reservations')} variant="outline" className="rounded-2xl h-12 px-8 font-bold">
                Volver a Mis Reservas
            </Button>
        </div>
    );


    return (
        <div className="w-full max-w-lg mx-auto p-4 space-y-6 pb-24">
            <header className="flex items-center justify-between">
                <h1 className="text-xl font-black tracking-tight">Ticket Digital</h1>
                <Button variant="ghost" size="icon" onClick={() => router.back()} className="rounded-full hover:bg-muted">
                    <XCircle className="w-6 h-6" />
                </Button>
            </header>

            <TicketDigital res={reservation} showActions={false} />

            {/* Cancel button */}
            {canCancel && (
                <Button
                    variant="ghost"
                    onClick={handleCancelRequest}
                    disabled={cancelling}
                    className="w-full text-rose-500 hover:text-rose-600 hover:bg-rose-50 rounded-xl font-bold py-5 text-xs uppercase tracking-widest border border-rose-100"
                >
                    {cancelling ? (
                        <span className="flex items-center gap-2">
                            <div className="w-4 h-4 border-2 border-rose-400 border-t-transparent rounded-full animate-spin" />
                            Cancelando...
                        </span>
                    ) : (
                        <span className="flex items-center gap-2">
                            <XCircle className="w-4 h-4" />
                            Cancelar Reserva
                        </span>
                    )}
                </Button>
            )}

            {/* Late cancellation confirmation dialog */}
            {showCancelConfirm && (
                <div
                    className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-6 animate-in fade-in duration-200"
                    onKeyDown={(e) => { if (e.key === 'Escape') setShowCancelConfirm(false); }}
                >
                    <div
                        role="alertdialog"
                        aria-modal="true"
                        aria-labelledby="cancel-dialog-title"
                        aria-describedby="cancel-dialog-desc"
                        className="bg-card rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-5 animate-in zoom-in-95 duration-200">
                        <div className="flex items-center gap-3">
                            <div className="bg-rose-100 p-3 rounded-2xl">
                                <XCircle className="w-6 h-6 text-rose-600" />
                            </div>
                            <h3 id="cancel-dialog-title" className="font-black text-lg text-foreground">¿Cancelar tu reserva?</h3>
                        </div>
                        <p id="cancel-dialog-desc" className="text-sm text-muted-foreground leading-relaxed">
                            {reservation ? `Tu reserva es ${format(new Date(reservation.date_time), "EEEE d 'de' MMMM 'a las' HH:mm", { locale: es })}. ` : ""}Como faltan menos de 1 hora, esta cancelación cuenta en tu reputación.
                        </p>
                        <div className="grid grid-cols-2 gap-3 pt-2">
                            <Button autoFocus variant="outline" className="rounded-xl h-12 font-bold" onClick={() => setShowCancelConfirm(false)}>
                                Mantener reserva
                            </Button>
                            <Button className="rounded-xl h-12 font-bold bg-rose-600 hover:bg-rose-700 text-white" onClick={performCancel}>
                                Cancelar reserva
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
