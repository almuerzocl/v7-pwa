"use client";

import React from 'react';
import { trackPlatformEvent } from "@/lib/platform-events";
import {
    MapPin, Clock, Utensils,
    Ticket, Flame, CalendarCheck, ShoppingBag, Heart, Bell, PersonStanding
} from 'lucide-react';
import { RestaurantData } from '@/types';
import { haversineMeters, walkingMinutes, formatDistance } from '@/hooks/useUserLocation';
import {
    Card, CardContent, CardFooter, CardHeader, CardTitle
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Image from 'next/image';
// import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
// import { Button } from '@/components/ui/button';

import { useAuth } from '@/context/AuthContext';
import { toggleFavoriteAction, toggleSubscriptionAction } from '@/app/actions/profile-actions';
import { useState, useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { ImpressionSentinel } from '@/components/blocks/ImpressionSentinel';
import type { ClientSurface } from '@/lib/client-events';

// Centralized RestaurantData is now imported from @/types

interface RestaurantCardProps {
    restaurant: RestaurantData;
    onClick?: () => void;
    priority?: boolean;
    isFavorite?: boolean;
    isSubscribed?: boolean;
    discountLogos?: string[];
    userLocation?: { lat: number; lng: number };
    /** Dónde se está mostrando la tarjeta (para medir impresiones). */
    surface?: ClientSurface;
    position?: number;
}

export function RestaurantCard({
    restaurant,
    onClick,
    priority = false,
    isFavorite: initialIsFavorite,
    isSubscribed: initialIsSubscribed,
    discountLogos,
    userLocation,
    surface = 'home',
    position,
}: RestaurantCardProps) {
    const { profile, user, refreshProfile } = useAuth();
    const [isFavorite, setIsFavorite] = useState(initialIsFavorite ?? false);
    const [isSubscribed, setIsSubscribed] = useState(initialIsSubscribed ?? false);
    const [isToggling, setIsToggling] = useState(false);

    useEffect(() => {
        if (initialIsFavorite !== undefined) setIsFavorite(initialIsFavorite);
        if (initialIsSubscribed !== undefined) setIsSubscribed(initialIsSubscribed);
        
        // Fallback for when props aren't provided but profile is available
        if (initialIsFavorite === undefined && profile) {
            setIsFavorite(profile.favorite_restaurant_ids?.includes(restaurant.id) || false);
        }
        if (initialIsSubscribed === undefined && profile) {
            setIsSubscribed(profile.subscribed_daily_menu_ids?.includes(restaurant.id) || false);
        }
    }, [initialIsFavorite, initialIsSubscribed, profile, restaurant.id]);

    const handleToggleFavorite = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!user) {
            toast.error("Inicia sesión para guardar favoritos");
            return;
        }

        if (isToggling) return;
        setIsToggling(true);

        // Optimistic update
        setIsFavorite(prev => !prev);

        try {
            const result = await toggleFavoriteAction(
                user.id,
                restaurant.id,
                profile?.favorite_restaurant_ids || []
            );
            if (!result.success) throw new Error(result.error);

            refreshProfile();
            trackPlatformEvent("favorite_toggle", { restaurantId: restaurant.id, step: !isFavorite ? "add" : "remove" });
            toast.success(!isFavorite ? "Añadido a favoritos" : "Eliminado de favoritos", {
                icon: !isFavorite ? "❤️" : "💔",
                style: { borderRadius: '1rem', background: '#333', color: '#fff', fontSize: '12px', fontWeight: 'bold' }
            });
        } catch (error) {
            // Revert optimistic update
            setIsFavorite(prev => !prev);
            console.error("Error toggling favorite:", error);
            toast.error("Error al actualizar favoritos");
        } finally {
            setIsToggling(false);
        }
    };

    const handleToggleSubscription = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!user) {
            toast.error("Inicia sesión para recibir alertas");
            return;
        }

        if (isToggling) return;
        setIsToggling(true);

        // Optimistic update
        setIsSubscribed(prev => !prev);

        try {
            const result = await toggleSubscriptionAction(
                user.id,
                restaurant.id,
                profile?.subscribed_daily_menu_ids || []
            );
            if (!result.success) throw new Error(result.error);

            refreshProfile();
            trackPlatformEvent("daily_menu_subscribe", { restaurantId: restaurant.id, step: !isSubscribed ? "add" : "remove" });
            toast.success(!isSubscribed ? "Suscrito a menú del día" : "Suscripción cancelada", {
                icon: !isSubscribed ? "🔔" : "🔕",
                style: { borderRadius: '1rem', background: '#333', color: '#fff', fontSize: '12px', fontWeight: 'bold' }
            });
        } catch (error) {
            // Revert optimistic update
            setIsSubscribed(prev => !prev);
            console.error("Error toggling subscription:", error);
            toast.error("Error al actualizar suscripción");
        } finally {
            setIsToggling(false);
        }
    };

    // Walking distance badge
    const walkingInfo = (() => {
        if (!userLocation || restaurant.lat == null || restaurant.lng == null) return null;
        const meters = haversineMeters(userLocation.lat, userLocation.lng, restaurant.lat, restaurant.lng);
        return { dist: formatDistance(meters), mins: walkingMinutes(meters) };
    })();

    // Generar nivel de precio "$$$"
    const renderPriceLevel = (level: number) => {
        return Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className={i < level ? "text-foreground font-bold" : "text-muted-foreground/40 font-light"}>
                $
            </span>
        ));
    };

    return (
        <Card
            onClick={onClick}
            className="group relative overflow-hidden flex flex-col transition-all hover:shadow-md cursor-pointer w-full max-w-sm bg-card rounded-xl border-border/60"
        >
            <ImpressionSentinel restaurantId={restaurant.id} surface={surface} position={position} />
            {/* 1. SECCIÓN VISUAL (Portada Compacta) */}
            <div className="relative h-28 w-full bg-muted overflow-hidden">
                {restaurant.coverImageUrl ? (
                    <Image
                        src={restaurant.coverImageUrl}
                        alt={`Portada de ${restaurant.name}`}
                        fill
                        className="object-cover transition-transform duration-500 group-hover:scale-105"
                        sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                        priority={priority}
                    />
                ) : (
                    <div className="flex bg-slate-100 items-center justify-center h-full w-full text-muted-foreground">
                        <Utensils className="h-8 w-8 opacity-20" />
                    </div>
                )}

                {/* Badges Flotantes Superiores */}
                <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
                    {restaurant.isSponsored && (
                        <Badge variant="default" className="bg-primary hover:bg-primary/90 shadow-sm space-x-1 px-1.5 py-0 text-[9px]">
                            <Ticket className="w-2.5 h-2.5" />
                            <span>Promo</span>
                        </Badge>
                    )}
                    {restaurant.isFeatured && (
                        <Badge variant="secondary" className="bg-white/95 text-primary hover:bg-white shadow-sm space-x-1 px-1.5 py-0 text-[9px]">
                            <Flame className="w-2.5 h-2.5 text-orange-500" />
                            <span>Destacado</span>
                        </Badge>
                    )}
                    {discountLogos && discountLogos.length > 0 && (
                        <div className="flex gap-1 mt-1">
                            {discountLogos.slice(0, 3).map((logo, i) => (
                                <div key={i} className="w-5 h-5 rounded-full bg-white shadow-sm border border-border/50 overflow-hidden">
                                    <img src={logo} alt="Descuento" className="w-full h-full object-contain" />
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {!restaurant.isActive ? (
                    <Badge variant="destructive" className="absolute top-2 right-2 shadow-sm text-[9px] px-1.5 py-0 z-10">
                        Cerrado
                    </Badge>
                ) : (
                    <div className="absolute top-2 right-2 flex flex-col gap-2 z-10">
                        <button
                            onClick={handleToggleFavorite}
                            disabled={isToggling}
                            className={cn(
                                "p-2 rounded-full shadow-lg backdrop-blur-md transition-all active:scale-90",
                                isFavorite 
                                    ? "bg-rose-500 text-white shadow-rose-500/20" 
                                    : "bg-white/90 text-muted-foreground hover:text-rose-500 hover:bg-white"
                            )}
                        >
                            <Heart className={cn("w-4 h-4", isFavorite && "fill-current")} />
                        </button>
                        <button
                            onClick={handleToggleSubscription}
                            disabled={isToggling}
                            className={cn(
                                "p-2 rounded-full shadow-lg backdrop-blur-md transition-all active:scale-90",
                                isSubscribed 
                                    ? "bg-indigo-500 text-white shadow-indigo-500/20" 
                                    : "bg-white/90 text-muted-foreground hover:text-indigo-500 hover:bg-white"
                            )}
                        >
                            <Bell className={cn("w-4 h-4", isSubscribed && "fill-current")} />
                        </button>
                    </div>
                )}
            </div>

            {/* 2. HEADER Y LOGO */}
            <CardHeader className="relative pt-3 pb-1 px-3">
                {/* Logo flotante más pequeño */}
                <div className="absolute -top-6 right-3 w-12 h-12 bg-white rounded-full p-0.5 shadow-sm border border-border/50 overflow-hidden relative">
                    {restaurant.logoUrl ? (
                        <Image
                            src={restaurant.logoUrl}
                            alt="Logo"
                            fill
                            className="object-cover rounded-full"
                            sizes="48px"
                        />
                    ) : (
                        <div className="w-full h-full bg-primary/10 rounded-full flex items-center justify-center">
                            <Utensils className="h-5 w-5 text-primary" />
                        </div>
                    )}
                </div>

                <div className="pr-12">
                    <CardTitle className="text-base font-bold truncate tracking-tight text-foreground group-hover:text-primary transition-colors">
                        {restaurant.name}
                    </CardTitle>
                    <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                        <span className="text-[10px] truncate max-w-[80px]">{restaurant.cuisineType}</span>
                        <span className="text-muted-foreground/40">•</span>
                        <span className="text-[10px] tracking-wider font-medium">{renderPriceLevel(restaurant.priceLevel)}</span>
                    </div>
                </div>
            </CardHeader>

            {/* 3. CONTENIDO PRINCIPAL */}
            <CardContent className="px-3 py-1.5 flex-grow space-y-2">
                {/* Ocultamos descripción intermedio en móvil, limitamos espacio */}
                <p className="text-[11px] text-muted-foreground line-clamp-1 sm:line-clamp-2 leading-tight">
                    {restaurant.description}
                </p>

                <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <MapPin className="w-3 h-3 text-primary/70 shrink-0" />
                        <span className="line-clamp-1">{restaurant.address}, <strong className="font-medium text-foreground">{restaurant.comuna}</strong></span>
                    </div>
                </div>
            </CardContent>

            {/* 4. FOOTER (Servicios e Interacción) */}
            <CardFooter className="px-3 py-2 bg-slate-50 border-t border-border/40 flex items-center justify-between">

                <div className="flex gap-1.5">
                    {restaurant.hasReservations ? (
                        <span className="flex items-center text-[9px] uppercase font-semibold text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded">
                            <CalendarCheck className="w-2.5 h-2.5 mr-0.5" /> Reserva
                        </span>
                    ) : (
                        <span className="text-[9px] uppercase font-semibold text-muted-foreground/40 px-1.5 py-0.5 border border-dashed border-border/50 rounded line-through">
                            Reserva
                        </span>
                    )}

                    {restaurant.hasTakeaway ? (
                        <span className="flex items-center text-[9px] uppercase font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">
                            <ShoppingBag className="w-2.5 h-2.5 mr-0.5" /> Llevar
                        </span>
                    ) : (
                        <span className="text-[9px] uppercase font-semibold text-muted-foreground/40 px-1.5 py-0.5 border border-dashed border-border/50 rounded line-through">
                            Llevar
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {walkingInfo && (
                        <div className="flex items-center gap-0.5 text-[9px] font-bold text-sky-600 bg-sky-50 px-1.5 py-0.5 rounded border border-sky-100">
                            <PersonStanding className="w-2.5 h-2.5 shrink-0" />
                            <span>{walkingInfo.dist}</span>
                            <span className="text-sky-400 font-normal">·</span>
                            <span>{walkingInfo.mins} min</span>
                        </div>
                    )}
                    {restaurant.hasTakeaway && (
                        <div className="flex items-center gap-1 text-[9px] font-medium text-muted-foreground">
                            <Clock className="w-2.5 h-2.5" />
                            ~{restaurant.averagePrepTimeMinutes}m
                        </div>
                    )}
                </div>

            </CardFooter>
        </Card>
    );
}
