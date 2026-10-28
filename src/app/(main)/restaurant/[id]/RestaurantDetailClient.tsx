"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    ArrowLeft,
    MapPin,
    Store,
    ShoppingBag,
    Clock,
    Info,
    Users,
    CalendarCheck,
    Smartphone,
    Heart,
    Bell,
    Share2,
    Phone
} from "lucide-react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { Badge } from "@/components/ui/badge";

const ReservationWizard = dynamic(() => import("@/components/blocks/ReservationWizard"), { ssr: false });
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/context/AuthContext";
import { toast } from "react-hot-toast";
import { trackClientEvent } from "@/lib/client-events";
import { trackPlatformEvent } from "@/lib/platform-events";

interface Props {
    restaurant: any;
    id: string;
}

export default function RestaurantDetailClient({ restaurant, id }: Props) {
    // El plan del local (tope alcanzado o sin vigencia) lo deja sin recibir reservas ni pedidos, aunque sus interruptores estén activos.
    const planBlocked = restaurant.plan_hidden === true;
    const canReserve = !planBlocked && !!(restaurant.has_reservations || restaurant.has_reservation);
    const canOrder = !planBlocked && !!restaurant.has_takeaway;
    const searchParams = useSearchParams();
    const router = useRouter();
    const isDraft = searchParams.get('draft') === 'reservation';

    useEffect(() => {
        if (isDraft) setShowReservation(true);
    }, [isDraft]);
    const { profile, user, refreshProfile } = useAuth();

    // Medición: abrir la ficha del local.
    useEffect(() => {
        trackClientEvent('profile_view', id, { surface: 'detail' });
    }, [id]);

    const [showReservation, setShowReservation] = useState(false);
    const [activeTab, setActiveTab] = useState("info");
    const [isFavorite, setIsFavorite] = useState(false);
    const [isSubscribed, setIsSubscribed] = useState(false);
    const [isToggling, setIsToggling] = useState(false);

    useEffect(() => {
        if (profile) {
            setIsFavorite(profile.favorite_restaurant_ids?.includes(id) || false);
            setIsSubscribed(profile.subscribed_daily_menu_ids?.includes(id) || false);
        }
    }, [profile, id]);

    const handleToggleFavorite = async () => {
        if (!user) {
            toast.error("Inicia sesión para guardar favoritos");
            return;
        }

        if (isToggling) return;
        setIsToggling(true);

        try {
            const currentFavs = profile?.favorite_restaurant_ids || [];
            let newFavs = [];

            if (isFavorite) {
                newFavs = currentFavs.filter(favId => favId !== id);
            } else {
                newFavs = [...currentFavs, id];
            }

            const { error } = await supabase
                .from('profiles')
                .update({ favorite_restaurant_ids: newFavs })
                .eq('id', user.id);

            if (error) throw error;

            setIsFavorite(!isFavorite);
            trackPlatformEvent("favorite_toggle", { restaurantId: id, step: isFavorite ? "remove" : "add" });
            refreshProfile().catch(() => {});
            toast.success(isFavorite ? "Eliminado de favoritos" : "Añadido a favoritos", {
                icon: isFavorite ? "💔" : "❤️",
                style: {
                    borderRadius: '1rem',
                    background: '#333',
                    color: '#fff',
                }
            });
        } catch (error) {
            console.error("Error toggling favorite:", error);
            toast.error("Error al actualizar favoritos");
        } finally {
            setIsToggling(false);
        }
    };

    const handleToggleSubscription = async () => {
        if (!user) {
            toast.error("Inicia sesión para recibir alertas");
            return;
        }

        if (isToggling) return;
        setIsToggling(true);

        try {
            const currentSubs = profile?.subscribed_daily_menu_ids || [];
            let newSubs = [];

            if (isSubscribed) {
                newSubs = currentSubs.filter(subId => subId !== id);
            } else {
                newSubs = [...currentSubs, id];
            }

            const { error } = await supabase
                .from('profiles')
                .update({ subscribed_daily_menu_ids: newSubs })
                .eq('id', user.id);

            if (error) throw error;

            setIsSubscribed(!isSubscribed);
            refreshProfile().catch(() => {});
            toast.success(isSubscribed ? "Suscripción cancelada" : "Suscrito a menú del día", {
                icon: isSubscribed ? "🔕" : "🔔",
                style: {
                    borderRadius: '1rem',
                    background: '#333',
                    color: '#fff',
                }
            });
        } catch (error) {
            console.error("Error toggling subscription:", error);
            toast.error("Error al actualizar suscripción");
        } finally {
            setIsToggling(false);
        }
    };

    // Compartir: hoja nativa del teléfono; si no existe, copia el enlace. Cancelar la hoja no cuenta como compartir.
    const handleShare = async () => {
        const url = `${window.location.origin}/restaurant/${id}`;
        const title = restaurant.name as string;
        try {
            if (typeof navigator.share === 'function') {
                await navigator.share({ title, text: `Mira ${title} en Almuerzo.cl`, url });
            } else {
                await navigator.clipboard.writeText(url);
                toast.success("Enlace copiado", { style: { borderRadius: '1rem', background: '#333', color: '#fff' } });
            }
            trackClientEvent('share', id, { surface: 'detail' });
        } catch (error) {
            if ((error as { name?: string })?.name === 'AbortError') return;
            toast.error("No se pudo compartir. Copia el enlace desde la barra del navegador.");
        }
    };

    // Solo dígitos y "+": el valor viene de la base y va a un enlace tel:.
    const phoneHref = typeof restaurant.phone === 'string' ? restaurant.phone.replace(/[^\d+]/g, '') : '';
    const canCall = phoneHref.replace(/\D/g, '').length >= 7;

    const addressStr = typeof restaurant.address === 'object' && restaurant.address !== null
        ? `${restaurant.address.street || ''} ${restaurant.address.number || ''}`.trim()
        : (restaurant.address || "Dirección no disponible");

    const daysTranslation: Record<string, string> = {
        monday: "Lunes", tuesday: "Martes", wednesday: "Miércoles", thursday: "Jueves",
        friday: "Viernes", saturday: "Sábado", sunday: "Domingo"
    };

    const currentDay = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

    return (
        <div className="w-full min-h-screen bg-slate-50/50 pb-32">
            {/* Action Bar Floating Top */}
            <div className="fixed top-0 left-0 right-0 z-50 p-4 flex justify-between items-center pointer-events-none">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => router.back()}
                    className="bg-white/90 backdrop-blur-md rounded-2xl text-slate-900 shadow-sm border border-slate-200 pointer-events-auto active:scale-95 transition-transform"
                >
                    <ArrowLeft className="w-5 h-5" />
                </Button>
                <div className="flex gap-2 pointer-events-auto">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleToggleFavorite}
                        disabled={isToggling}
                        className={cn(
                            "backdrop-blur-md rounded-2xl shadow-sm border active:scale-95 transition-all w-11 h-11 pointer-events-auto",
                            isFavorite 
                                ? "bg-rose-500 text-white border-rose-400" 
                                : "bg-white/90 text-slate-900 border-slate-200"
                        )}
                    >
                        <Heart className={cn("w-5 h-5", isFavorite && "fill-current")} />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleToggleSubscription}
                        disabled={isToggling}
                        className={cn(
                            "backdrop-blur-md rounded-2xl shadow-sm border active:scale-95 transition-all w-11 h-11 pointer-events-auto",
                            isSubscribed 
                                ? "bg-indigo-500 text-white border-indigo-400" 
                                : "bg-white/90 text-slate-900 border-slate-200"
                        )}
                    >
                        <Bell className={cn("w-5 h-5", isSubscribed && "fill-current")} />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleShare}
                        aria-label="Compartir este restaurante"
                        className="bg-white/90 backdrop-blur-md rounded-2xl text-slate-900 shadow-sm border border-slate-200 active:scale-95 transition-transform w-11 h-11 pointer-events-auto"
                    >
                        <Share2 className="w-5 h-5" />
                    </Button>
                </div>
            </div>

            {/* Premium Hero Image */}
            <div className="relative h-80 w-full overflow-hidden">
                {restaurant.cover_image_url ? (
                    <img
                        src={restaurant.cover_image_url}
                        alt={restaurant.name}
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="w-full h-full bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center">
                        <Store className="w-16 h-16 text-slate-300" />
                    </div>
                )}
                <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-slate-50/50 to-transparent" />
            </div>

            {/* Main Content Card */}
            <div className="max-w-lg mx-auto -mt-16 relative px-4">
                <div className="bg-white rounded-[3rem] shadow-xl shadow-slate-200/50 p-6 md:p-8 border border-slate-100 space-y-6 relative overflow-visible">
                    
                    {/* Floating Brand Mark */}
                    <div className="absolute -top-12 left-8 w-24 h-24 bg-white rounded-[2rem] p-1 shadow-2xl shadow-slate-900/10 border border-slate-100 z-10">
                        {restaurant.logo_url ? (
                            <img
                                src={restaurant.logo_url}
                                alt="Logo"
                                className="w-full h-full object-cover rounded-[1.8rem]"
                            />
                        ) : (
                            <div className="w-full h-full bg-slate-50 flex items-center justify-center rounded-[1.8rem]">
                                <Store className="w-8 h-8 text-slate-200" />
                            </div>
                        )}
                    </div>

                    {/* Brand & Header */}
                    <div className="space-y-4 pt-8">
                        <div className="flex justify-between items-start">
                            <div className="space-y-1">
                                <h1 className="text-3xl font-black tracking-tighter text-slate-900 leading-tight">
                                    {restaurant.name}
                                </h1>
                                <div className="flex items-center gap-2">
                                    <Badge variant="secondary" className="bg-primary/10 text-primary border-none text-[10px] font-bold uppercase tracking-widest px-2 shadow-none">
                                        {restaurant.cuisine_type || 'Gourmet'}
                                    </Badge>
                                    <div className="flex items-center gap-1 text-xs font-bold text-slate-400">
                                        <MapPin className="w-3 h-3 text-primary" />
                                        {restaurant.comuna || 'Santiago'}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <p className="text-sm text-slate-500 leading-relaxed font-medium">
                            {restaurant.description || "Un espacio diseñado para los amantes de la buena mesa, con ingredientes frescos y atención de primer nivel."}
                        </p>
                    </div>

                    <div className="h-px bg-slate-100 w-full" />

                    {/* Navigation Tabs */}
                    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                        <TabsList className="grid grid-cols-3 bg-slate-50 p-1.5 rounded-2xl h-14 border border-slate-100 mb-6">
                            <TabsTrigger value="info" className="rounded-xl font-bold text-[11px] uppercase tracking-wider data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-primary">
                                <Info className="w-3.5 h-3.5 mr-1.5" /> Detalles
                            </TabsTrigger>
                            <TabsTrigger value="hours" className="rounded-xl font-bold text-[11px] uppercase tracking-wider data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-primary">
                                <Clock className="w-3.5 h-3.5 mr-1.5" /> Horarios
                            </TabsTrigger>
                            <TabsTrigger value="spaces" className="rounded-xl font-bold text-[11px] uppercase tracking-wider data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-primary">
                                <Users className="w-3.5 h-3.5 mr-1.5" /> Espacios
                            </TabsTrigger>
                        </TabsList>

                        {/* INFO TAB */}
                        <TabsContent value="info" className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <div className="bg-slate-50 p-5 rounded-3xl space-y-4 border border-slate-100">
                                <div className="flex items-center gap-4">
                                    <div className="bg-white p-2.5 rounded-2xl shadow-sm border border-slate-100">
                                        <MapPin className="w-5 h-5 text-primary" />
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1 text-xs">Ubicación</p>
                                        <p className="text-sm font-bold text-slate-800 tracking-tight">{addressStr}</p>
                                    </div>
                                </div>
                                {canCall && (
                                    <div className="flex items-center gap-4">
                                        <div className="bg-white p-2.5 rounded-2xl shadow-sm border border-slate-100">
                                            <Phone className="w-5 h-5 text-primary" />
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1 text-xs">Teléfono</p>
                                            <p className="text-sm font-bold text-slate-800 tracking-tight">{restaurant.phone}</p>
                                        </div>
                                        <a
                                            href={`tel:${phoneHref}`}
                                            onClick={() => trackClientEvent('call', id, { surface: 'detail' })}
                                            className="inline-flex h-11 items-center rounded-2xl bg-primary px-4 text-xs font-black uppercase tracking-wider text-white shadow-sm active:scale-95 transition-transform"
                                        >
                                            Llamar
                                        </a>
                                    </div>
                                )}
                                <div className="flex items-center gap-4">
                                    <div className="bg-white p-2.5 rounded-2xl shadow-sm border border-slate-100">
                                        <Smartphone className="w-5 h-5 text-primary" />
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1 text-xs">Reservas Digitales</p>
                                        <p className="text-sm font-bold text-slate-800 tracking-tight">Confirmación Inmediata v5</p>
                                    </div>
                                </div>
                            </div>

                            {/* Features Grid - Only show if we had real data from DB */}
                            {restaurant.amenities && (
                                <div className="grid grid-cols-2 gap-3">
                                    {restaurant.amenities.map((amenity: any, idx: number) => (
                                        <div key={idx} className="flex items-center gap-2 p-3 bg-white border border-slate-100 rounded-2xl shadow-sm">
                                            <span className="text-[11px] font-bold text-slate-600">{amenity}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </TabsContent>

                        {/* HOURS TAB */}
                        <TabsContent value="hours" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <div className="bg-slate-900 rounded-[2.5rem] p-6 text-white space-y-4 shadow-xl shadow-slate-900/20 relative overflow-hidden">
                                <Clock className="absolute -right-4 -top-4 w-24 h-24 text-white/5 rotate-12" />
                                <h3 className="text-sm font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                                    Configuración de Apertura
                                </h3>
                                <div className="space-y-2.5">
                                    {Object.entries(daysTranslation).map(([key, label]) => {
                                        const isToday = currentDay === key;
                                        const hours = restaurant.opening_hours?.[key];
                                        const hoursStr = Array.isArray(hours) && hours.length > 0
                                            ? `${hours[0].open} - ${hours[0].close}`
                                            : (hours?.open ? `${hours.open} - ${hours.close}` : "Cerrado");

                                        return (
                                            <div key={key} className={cn(
                                                "flex justify-between items-center py-2 px-1 transition-all rounded-xl",
                                                isToday ? "bg-white/10 scale-105 px-3 border border-white/10" : "opacity-60"
                                            )}>
                                                <span className="font-bold text-sm tracking-tight">{label}</span>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-black mono text-primary">{hoursStr}</span>
                                                    {isToday && <Badge className="bg-emerald-500 text-[8px] h-4 rounded-full border-none">HOY</Badge>}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </TabsContent>

                        {/* SPACES TAB */}
                        <TabsContent value="spaces" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <div className="space-y-4">
                                <div className="flex flex-col gap-4">
                                    {restaurant.space_capacities ? (
                                        Object.entries(restaurant.space_capacities).map(([space, cap]: [string, any]) => (
                                            <div key={space} className="flex items-center justify-between p-5 bg-white border-2 border-slate-50 rounded-3xl shadow-sm group hover:border-primary/20 transition-all">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                                                        <Store className="w-6 h-6" />
                                                    </div>
                                                    <div>
                                                        <h4 className="font-black text-slate-800 uppercase tracking-tight text-sm">{space}</h4>
                                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Capacidad máxima</p>
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <span className="text-2xl font-black text-slate-900">{cap}</span>
                                                    <span className="text-[10px] font-black text-slate-400 uppercase ml-1">Lugares</span>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-center py-10 bg-slate-50 rounded-3xl border border-dashed border-slate-200">
                                            <p className="text-xs font-bold text-slate-400 uppercase">Configuración de espacios no detallada</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </TabsContent>
                    </Tabs>
                </div>
            </div>

            {/* Premium Sticky Action Bar - Adjusted for MobileNav height */}
            <div className="fixed bottom-[68px] left-0 right-0 p-4 z-[500] bg-gradient-to-t from-background via-background/80 to-transparent pt-8">
                {planBlocked && (
                    <p className="max-w-lg mx-auto mb-2 text-center text-xs font-bold text-slate-500" role="status">
                        Este local no está recibiendo reservas ni pedidos por el momento.
                    </p>
                )}
                <div className="max-w-lg mx-auto grid grid-cols-2 gap-3">
                    <Button
                        disabled={!canReserve}
                        onClick={() => setShowReservation(true)}
                        className={cn(
                            "h-16 rounded-2xl flex flex-col gap-1 font-black shadow-xl transition-all active:scale-95 group overflow-hidden relative",
                            canReserve
                                ? "bg-slate-900 text-white shadow-slate-900/20"
                                : "bg-slate-100 text-slate-400 opacity-50"
                        )}
                    >
                        <CalendarCheck className="w-4 h-4 group-hover:scale-110 transition-transform" />
                        <div className="text-center flex flex-col">
                            <span className="text-[10px] uppercase tracking-tight">Reservar Mesa</span>
                            <span className="text-[7px] opacity-60 font-black uppercase tracking-[0.1em]">Instantáneo</span>
                        </div>
                    </Button>

                    <Button
                        disabled={!canOrder}
                        variant="outline"
                        onClick={() => router.push(`/restaurant/${id}/menu`)}
                        className={cn(
                            "h-16 rounded-2xl flex flex-col gap-1 font-black border-2 transition-all active:scale-95 shadow-lg group relative overflow-hidden",
                            canOrder
                                ? "border-primary bg-primary text-white shadow-primary/20 hover:bg-primary/95"
                                : "bg-slate-100 border-transparent text-slate-400 opacity-50"
                        )}
                    >
                        <ShoppingBag className="w-4 h-4 group-hover:scale-110 transition-transform" />
                        <div className="text-center flex flex-col">
                            <span className="text-[10px] uppercase tracking-tight">Pedir p/ Llevar</span>
                            <span className="text-[7px] opacity-70 font-black uppercase tracking-[0.1em]">Menú Digital</span>
                        </div>
                    </Button>
                </div>
            </div>

            {showReservation && (
                <ReservationWizard
                    restaurantId={id}
                    restaurantName={restaurant.name}
                    address={addressStr}
                    onClose={() => setShowReservation(false)}
                />
            )}
        </div>
    );
}
