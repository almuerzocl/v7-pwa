"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Utensils, Calendar, Search, MapPin, SlidersHorizontal, PersonStanding, Car, Globe, ArrowUpNarrowWide, Ticket } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useLocation } from '@/context/LocationContext';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/core-business/ui-helpers';
import { RestaurantCard } from "@/components/blocks/RestaurantCard";
import { RestaurantData } from '@/types';
import dynamic from 'next/dynamic';
import { supabase } from '@/lib/supabase';
import { useUserLocation, haversineMeters } from '@/hooks/useUserLocation';
import { DAILY_MENU_EMBED, extractDailyMenus } from '@/lib/inventory';
import { ActiveTicketCard } from '@/components/blocks/ActiveTicketCard';
import { ImpressionSentinel } from '@/components/blocks/ImpressionSentinel';

// Lazy load heavy components
const ReservationWizard = dynamic(() => import("@/components/blocks/ReservationWizard"), { ssr: false });
const RestaurantActionModal = dynamic(() => import('@/components/blocks/RestaurantActionModal').then(m => m.RestaurantActionModal), { ssr: false });

interface HomeClientProps {
    initialRestaurants: RestaurantData[];
    /** Ícono de OlivIA (solo si está encendida): va arriba a la derecha, junto al título, sin tapar nada. */
    assistant?: React.ReactNode;
}

export default function HomeClient({ initialRestaurants, assistant }: HomeClientProps) {
    const { profile } = useAuth();
    const { location: userLocation } = useUserLocation();
    const { address: headerAddress, lat: headerLat, lng: headerLng } = useLocation();
    const [restaurants, setRestaurants] = useState<RestaurantData[]>(initialRestaurants);
    const [loading, setLoading] = useState(false);
    const [actionRestaurant, setActionRestaurant] = useState<RestaurantData | null>(null);
    const [selectedRestaurant, setSelectedRestaurant] = useState<RestaurantData | null>(null);
    const [activeView, setActiveView] = useState<'restaurants' | 'menus'>('restaurants');
    const [searchQuery, setSearchQuery] = useState("");
    const [sortBy, setSortBy] = useState<'all' | 'price' | 'distance' | 'discount'>('all');
    const [distanceLevel, setDistanceLevel] = useState<0 | 1 | 2>(2);

    const DISTANCE_MAX = [1_666, 8_333, Infinity] as const;
    const [discountRestaurantIds, setDiscountRestaurantIds] = useState<Set<string>>(new Set());
    const [discountLogos, setDiscountLogos] = useState<Record<string, string[]>>({});

    useEffect(() => {
        fetchRestaurants();
    }, []);

    useEffect(() => {
        const fetchDiscountRestaurants = async () => {
            // Vía /api/restaurants-with-discounts: si falla (o el caché de descuentos no está), el listado
            // se muestra igual, solo sin logos de descuento.
            try {
                const res = await fetch('/api/restaurants-with-discounts', { credentials: 'same-origin' });
                const json = await res.json();
                if (!json?.ok || !Array.isArray(json.restaurants)) {
                    console.error('[Discounts] Listado de descuentos no disponible:', json?.reason ?? res.status);
                    return;
                }
                setDiscountRestaurantIds(new Set(json.restaurants.map((d: any) => d.restaurantId)));
                const logos: Record<string, string[]> = {};
                json.restaurants.forEach((d: any) => { logos[d.restaurantId] = d.logos || []; });
                setDiscountLogos(logos);
            } catch (err) {
                console.error('[Discounts] No se pudo consultar el listado de descuentos:', err);
            }
        };
        fetchDiscountRestaurants();
    }, []);

    const fetchRestaurants = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('restaurants')
                .select(`
                    id, name, description, logo_url, cover_image_url, cuisine_type, price_level,
                    address, comuna, phone, has_reservations, has_takeaway, average_prep_time,
                    is_sponsored, is_featured, is_active, lat, lng,
                    ${DAILY_MENU_EMBED}
                `)
                .eq('is_active', true)
                .eq('plan_hidden', false) // sin cupo en su plan: no aparece en el listado (el interruptor del dueño no se toca)
                .order('is_sponsored', { ascending: false })
                .limit(30);

            if (error) throw error;

            const mapped: RestaurantData[] = (data || []).map((r: any) => ({
                id: r.id,
                name: r.name,
                description: r.description || '',
                logoUrl: r.logo_url,
                coverImageUrl: r.cover_image_url,
                cuisineType: r.cuisine_type || 'Varios',
                priceLevel: Number(r.price_level) || 2,
                address: typeof r.address === 'object' && r.address !== null ? `${r.address.street || ''} ${r.address.number || ''}`.trim() : (r.address || ''),
                comuna: r.comuna || '',
                phoneNumber: r.phone,
                hasReservations: r.has_reservations ?? true,
                hasTakeaway: r.has_takeaway ?? true,
                averagePrepTimeMinutes: Number(r.average_prep_time) || 20,
                isSponsored: r.is_sponsored || false,
                isFeatured: r.is_featured || false,
                isActive: r.is_active || true,
                lat: r.lat ?? undefined,
                lng: r.lng ?? undefined,
                dailyMenus: extractDailyMenus(r)
            }));

            setRestaurants(mapped);
        } catch (error) {
            console.error("Error loading restaurants:", error);
        } finally {
            setLoading(false);
        }
    };

    // Location priority: address selected/detected in the top header → live GPS.
    // The header is what the user sees and can change ("Quiero buscar en la dirección"),
    // so it must win over the device's GPS or a manually chosen address never reaches
    // the list. Live GPS is only the fallback while the header has no coordinates.
    const effectiveLocation = headerLat != null && headerLng != null
        ? { lat: headerLat, lng: headerLng }
        : userLocation ?? undefined;
    const uLat = effectiveLocation?.lat;
    const uLng = effectiveLocation?.lng;

    // D: pre-compute cheapest menu price per restaurant once (not inside sort comparator)
    const cheapestPrice = useMemo(() =>
        new Map(restaurants.map(r => [
            r.id,
            r.dailyMenus?.length
                ? Math.min(...r.dailyMenus.map((m: any) => Number(m.price) || Infinity))
                : Infinity
        ])),
        [restaurants]
    );

    // E: pre-compute haversine distances once (not twice per sort comparison)
    const distanceMap = useMemo(() => {
        if (!uLat || !uLng) return new Map<string, number>();
        return new Map(restaurants.map(r => [
            r.id,
            (r.lat != null && r.lng != null) ? haversineMeters(uLat, uLng, r.lat, r.lng) : Infinity
        ]));
    }, [restaurants, uLat, uLng]);

    const filteredRestaurants = useMemo(() => {
        const maxMeters = DISTANCE_MAX[distanceLevel];

        let list = restaurants.filter(r => {
            const matchesSearch = r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                r.cuisineType.toLowerCase().includes(searchQuery.toLowerCase());
            if (!matchesSearch) return false;
            if (sortBy === 'discount' && !discountRestaurantIds.has(r.id)) return false;
            if (maxMeters < Infinity) {
                // No user location: can't compute distance → exclude all (filter has no meaning)
                if (!uLat || !uLng) return false;
                // Restaurant has no coordinates → can't measure → exclude
                if (r.lat == null || r.lng == null) return false;
                return (distanceMap.get(r.id) ?? Infinity) <= maxMeters;
            }
            return true;
        });

        if (sortBy === 'price') {
            list = [...list].sort((a, b) => (cheapestPrice.get(a.id) ?? Infinity) - (cheapestPrice.get(b.id) ?? Infinity));
        } else if (sortBy === 'distance' && uLat && uLng) {
            list = [...list].sort((a, b) => (distanceMap.get(a.id) ?? Infinity) - (distanceMap.get(b.id) ?? Infinity));
        }

        return list;
    }, [restaurants, searchQuery, sortBy, discountRestaurantIds, distanceLevel, uLat, uLng, cheapestPrice, distanceMap]);

    // Menus view: flatten all menus from filtered restaurants into a globally sortable list
    const sortedMenuItems = useMemo(() => {
        const pairs: { menu: any; restaurant: RestaurantData }[] = [];
        filteredRestaurants.forEach(r => {
            (r.dailyMenus || []).forEach((menu: any) => {
                pairs.push({ menu, restaurant: r });
            });
        });
        if (sortBy === 'price') {
            pairs.sort((a, b) => (Number(a.menu.price) || 0) - (Number(b.menu.price) || 0));
        }
        return pairs;
    }, [filteredRestaurants, sortBy]);

    return (
        <div className="flex flex-col min-h-screen bg-slate-50/30">
            {/* NO Header here - already in MainLayout */}

            <main className="flex-1 w-full max-w-lg mx-auto px-3 sm:px-4 space-y-6 pb-[300px]">
                
                {/* 1. Selector de Vista (Switch) */}
                <div className="flex bg-white/60 backdrop-blur-md p-1.5 rounded-[1.5rem] border border-border/40 shadow-sm">
                    <button
                        onClick={() => setActiveView('restaurants')}
                        className={cn(
                            "flex-1 h-11 rounded-[1.1rem] text-xs font-bold transition-all flex items-center justify-center gap-2",
                            activeView === 'restaurants' ? "bg-white text-primary shadow-sm border border-border/50" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <Utensils className="w-4 h-4" />
                        Restaurantes
                    </button>
                    <button
                        onClick={() => setActiveView('menus')}
                        className={cn(
                            "flex-1 h-11 rounded-[1.1rem] text-xs font-bold transition-all flex items-center justify-center gap-2",
                            activeView === 'menus' ? "bg-white text-primary shadow-sm border border-border/50" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <Calendar className="w-4 h-4" />
                        Menús del Día
                    </button>
                </div>


                <ActiveTicketCard />

                {/* 3. Título de Sección dinámico */}
                <section className="space-y-4">
                    <div className={cn("flex flex-col gap-1", assistant && "relative pr-24")}>
                        {assistant && <div className="absolute right-0 top-0">{assistant}</div>}
                        <h2 className="text-2xl font-black tracking-tighter text-foreground">
                            {activeView === 'restaurants' ? "Restaurantes Cerca de Ti" : "Menús de Hoy"}
                        </h2>
                        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                            {loading
                                ? "Cargando locales..."
                                : activeView === 'menus'
                                    ? `${sortedMenuItems.length} menú${sortedMenuItems.length !== 1 ? 's' : ''} disponible${sortedMenuItems.length !== 1 ? 's' : ''}`
                                    : `Mostrando ${filteredRestaurants.length} locales en ${headerAddress?.split(',').pop()?.trim() || 'Santiago'}`
                            }
                        </p>
                    </div>

                    <div className="flex flex-col gap-5">
                        {activeView === 'restaurants' ? (
                            filteredRestaurants.map((restaurant, idx) => {
                                const isFavorite = profile?.favorite_restaurant_ids?.includes(restaurant.id);
                                const isSubscribed = profile?.subscribed_daily_menu_ids?.includes(restaurant.id);

                                return (
                                    <RestaurantCard
                                        key={restaurant.id}
                                        restaurant={restaurant}
                                        onClick={() => setActionRestaurant(restaurant)}
                                        priority={idx < 4}
                                        isFavorite={isFavorite}
                                        isSubscribed={isSubscribed}
                                        discountLogos={discountLogos[restaurant.id]}
                                        userLocation={effectiveLocation}
                                        surface="home"
                                        position={idx}
                                    />
                                );
                            })
                        ) : (
                            sortedMenuItems.map(({ menu, restaurant }, menuIdx) => (
                                <div
                                    key={`${restaurant.id}-${menu.id}`}
                                    className="bg-card border border-border rounded-3xl overflow-hidden shadow-sm hover:shadow-md active:scale-[0.98] transition-all cursor-pointer relative group"
                                    onClick={() => setActionRestaurant(restaurant)}
                                >
                                    <ImpressionSentinel restaurantId={restaurant.id} surface="home_menus" position={menuIdx} />
                                    <div className="h-44 sm:h-56 relative overflow-hidden bg-muted">
                                        {menu.imageUrl ? (
                                            <img src={menu.imageUrl} alt={menu.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                        ) : (
                                            <img src={restaurant.coverImageUrl} alt={restaurant.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                        )}
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>

                                        <div className="absolute top-4 left-4 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 flex items-center gap-1.5 shadow-xl">
                                            <Utensils className="w-3 h-3 text-white/90" />
                                            <span className="text-white text-xs font-black tracking-widest uppercase truncate max-w-[180px]">{restaurant.name}</span>
                                        </div>

                                        <div className="absolute bottom-4 left-4 right-4 flex justify-between items-end gap-4">
                                            <div className="space-y-1">
                                                <span className="text-primary-foreground/80 text-xs font-black uppercase tracking-widest bg-primary/90 px-2 py-0.5 rounded-md inline-block mb-1">Menú del Día</span>
                                                <h3 className="text-white font-black text-lg sm:text-2xl leading-tight line-clamp-2">{menu.name}</h3>
                                            </div>
                                            <div className="bg-white px-3 py-2 rounded-xl shadow-xl shrink-0 border border-white/20">
                                                <span className="text-slate-900 font-black text-base">{formatCurrency(menu.price)}</span>
                                            </div>
                                        </div>
                                    </div>
                                    {menu.description && (
                                        <div className="p-4 bg-white/50 backdrop-blur-sm border-t border-border/50">
                                            <p className="text-sm text-muted-foreground font-medium leading-relaxed line-clamp-3">{menu.description}</p>
                                        </div>
                                    )}
                                </div>
                            ))
                        )}

                        {!loading && (activeView === 'restaurants' ? filteredRestaurants.length === 0 : sortedMenuItems.length === 0) && (
                            <div className="py-20 text-center space-y-4 bg-white/40 rounded-[2.5rem] border border-dashed border-border">
                                <MapPin className="w-12 h-12 text-muted-foreground/20 mx-auto" />
                                <p className="text-muted-foreground font-medium">
                                    {activeView === 'menus' ? "No hay menús disponibles con esos filtros." : "No encontramos locales con esos filtros."}
                                </p>
                                <p className="text-xs text-muted-foreground px-6">Prueba ampliando la distancia, quitando la búsqueda o cambiando el orden.</p>
                                <button onClick={() => { setSortBy('all'); setSearchQuery(""); setDistanceLevel(2); }} className="inline-flex items-center justify-center min-h-11 px-6 rounded-2xl bg-primary text-white font-bold text-sm">Quitar filtros</button>
                            </div>
                        )}
                    </div>
                </section>
            </main>

            {/* ── Floating search + filters ── */}
            <div className="fixed bottom-[68px] left-0 right-0 z-20 px-3 pb-2 pointer-events-none">
                <div className="max-w-lg mx-auto pointer-events-auto">
                    <div className="bg-white/95 backdrop-blur-xl rounded-[2rem] shadow-2xl border border-border/30 px-4 pt-3 pb-4 space-y-3">

                        {/* Search input */}
                        <div className="relative group">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
                            <input
                                type="text"
                                placeholder={activeView === 'restaurants' ? "Busca tu sabor favorito..." : "Busca platos, sopas..."}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full h-12 pl-11 pr-4 bg-muted/40 border border-border/50 rounded-[1.1rem] outline-none focus:ring-0 focus:border-primary/30 transition-all font-bold text-sm"
                            />
                        </div>

                        {/* Sort pills */}
                        <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
                            {([
                                { key: 'all',      label: 'Todos',         icon: Globe },
                                { key: 'price',    label: 'Precio ↑',      icon: ArrowUpNarrowWide },
                                { key: 'distance', label: 'Distancia ↑',   icon: PersonStanding },
                                { key: 'discount', label: 'Con descuento',  icon: Ticket },
                            ] as const).map(({ key, label, icon: Icon }) => (
                                <button
                                    key={key}
                                    onClick={() => setSortBy(key)}
                                    className={cn(
                                        "whitespace-nowrap flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-extrabold transition-all border shrink-0",
                                        sortBy === key
                                            ? "bg-primary text-white border-primary shadow-md shadow-primary/20"
                                            : "bg-muted/50 text-muted-foreground border-border/60 hover:border-primary/30"
                                    )}
                                >
                                    <Icon className="w-3 h-3" />
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* Distance slider */}
                        <div className="relative px-1">
                            <div className="absolute top-[18px] inset-x-5 h-1 bg-border/50 rounded-full" />
                            <div
                                className="absolute top-[18px] left-5 h-1 bg-primary rounded-full transition-all duration-300"
                                style={{ width: distanceLevel === 0 ? '0%' : distanceLevel === 1 ? '50%' : '100%' }}
                            />
                            <div className="relative flex justify-between px-1">
                                {([
                                    { level: 0 as const, icon: PersonStanding, label: 'Caminando', sub: '<20 min' },
                                    { level: 1 as const, icon: Car,             label: 'Cercanos',  sub: '~30 min' },
                                    { level: 2 as const, icon: Globe,           label: 'Todos',     sub: 'Sin límite' },
                                ] as const).map(({ level, icon: Icon, label, sub }) => (
                                    <button
                                        key={level}
                                        onClick={() => setDistanceLevel(level)}
                                        className="flex flex-col items-center gap-1"
                                    >
                                        <div className={cn(
                                            "w-8 h-8 rounded-full border-2 flex items-center justify-center transition-all duration-200",
                                            distanceLevel === level
                                                ? "bg-primary border-primary text-white shadow-sm shadow-primary/30 scale-110"
                                                : "bg-white border-border text-muted-foreground"
                                        )}>
                                            <Icon className="w-3.5 h-3.5" />
                                        </div>
                                        <span className={cn(
                                            "text-xs font-extrabold leading-none",
                                            distanceLevel === level ? "text-primary" : "text-muted-foreground"
                                        )}>{label}</span>
                                        <span className="text-xs text-muted-foreground/50 font-medium leading-none">{sub}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                    </div>
                </div>
            </div>

            {/* Footer with privacy link */}
            <footer className="py-8 text-center space-y-2">
                <p className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground/40">Almuerzo.cl</p>
                <a href="/privacidad" className="text-xs font-bold text-muted-foreground/50 hover:text-orange-500 transition-colors underline underline-offset-2">
                    Política de Privacidad
                </a>
            </footer>

            {selectedRestaurant && (
                <ReservationWizard
                    restaurantId={selectedRestaurant.id}
                    restaurantName={selectedRestaurant.name}
                    onClose={() => setSelectedRestaurant(null)}
                />
            )}

            {actionRestaurant && (
                <RestaurantActionModal
                    restaurant={actionRestaurant}
                    isOpen={!!actionRestaurant}
                    onClose={() => setActionRestaurant(null)}
                    onReserve={(r) => setSelectedRestaurant(r)}
                />
            )}
        </div>
    );
}

