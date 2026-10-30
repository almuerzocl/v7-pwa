"use client";

import { useAuth } from "@/context/AuthContext";
import { ArrowLeft, BellRing, Loader2, Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { RestaurantCard } from "@/components/blocks/RestaurantCard";
import type { RestaurantData } from "@/types";
import ReservationWizard from "@/components/blocks/ReservationWizard";
import { RestaurantActionModal } from "@/components/blocks/RestaurantActionModal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ALL_MENU_EMBED, extractDailyMenus } from "@/lib/inventory";

export default function FavoritesPage() {
    const { user, profile } = useAuth();
    const router = useRouter();
    const [favorites, setFavorites] = useState<RestaurantData[]>([]);
    const [subscriptions, setSubscriptions] = useState<RestaurantData[]>([]);
    const [loading, setLoading] = useState(true);
    const [actionRestaurant, setActionRestaurant] = useState<RestaurantData | null>(null);
    const [selectedRestaurant, setSelectedRestaurant] = useState<RestaurantData | null>(null);

    const fetchData = useCallback(async () => {
        const favIds = profile?.favorite_restaurant_ids || [];
        const subIds = profile?.subscribed_daily_menu_ids || [];

        const allIds = Array.from(new Set([...favIds, ...subIds])) as string[];
        if (allIds.length === 0) {
            setLoading(false);
            return;
        }

        try {
            const { data, error } = await supabase
                .from('restaurants')
                // Lista explícita (sin `*`): `restaurants` tiene columnas internas (plan de suscripción, fecha de cobro) que no
                // deben viajar a clientes; esta lista es exactamente lo que usa el mapeo de abajo.
                .select(`
                    id, name, description, logo_url, cover_image_url, cuisine_type, price_level,
                    address, comuna, phone, has_reservations, has_takeaway, average_prep_time,
                    is_sponsored, is_featured, is_active,
                    ${ALL_MENU_EMBED}
                `)
                .in('id', allIds)
                .eq('plan_hidden', false); // un local sin cupo en su plan no se lista, tampoco entre favoritos

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
                dailyMenus: extractDailyMenus(r)
            }));

            setFavorites(mapped.filter(r => favIds.includes(r.id)));
            setSubscriptions(mapped.filter(r => subIds.includes(r.id)));
        } catch (error) {
            console.error("Error loading data:", error);
        } finally {
            setLoading(false);
        }
    }, [profile, supabase]);

    useEffect(() => {
        if (user) {
            fetchData();
        } else {
            setLoading(false);
        }
    }, [user, profile, fetchData]);

    return (
        <div className="w-full min-h-screen bg-slate-50 pb-24">
            <header className="sticky top-0 bg-white/80 backdrop-blur-xl z-50 border-b border-slate-100 p-4">
                <div className="max-w-md mx-auto flex items-center gap-4">
                    <Button variant="ghost" size="icon" onClick={() => router.back()} className="rounded-2xl bg-slate-100/50 hover:bg-slate-100 transition-colors shrink-0">
                        <ArrowLeft className="w-5 h-5 text-slate-600" />
                    </Button>
                    <div>
                        <h1 className="text-lg font-black tracking-tight text-slate-900 leading-none">Mis Guardados</h1>
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Favoritos y Alertas</p>
                    </div>
                </div>
            </header>

            <main className="max-w-md mx-auto p-4">
                {loading ? (
                    <div className="space-y-4 pt-10">
                        <div className="flex flex-col items-center justify-center space-y-4">
                            <Loader2 className="w-8 h-8 text-primary animate-spin" />
                            <p className="text-sm font-bold text-slate-400 animate-pulse">Sincronizando tus gustos...</p>
                        </div>
                    </div>
                ) : (
                    <Tabs defaultValue="favorites" className="w-full space-y-6">
                        <TabsList className="grid w-full grid-cols-2 bg-slate-100/80 p-1.5 rounded-[1.5rem] h-14">
                            <TabsTrigger value="favorites" className="rounded-xl font-black text-xs uppercase tracking-tight data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-primary transition-all">
                                <Heart className="w-4 h-4 mr-2" />
                                Favoritos
                            </TabsTrigger>
                            <TabsTrigger value="subscriptions" className="rounded-xl font-black text-xs uppercase tracking-tight data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-blue-600 transition-all">
                                <BellRing className="w-4 h-4 mr-2" />
                                Suscripciones
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="favorites" className="space-y-4 focus-visible:outline-none">
                            {favorites.length > 0 ? (
                                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                    {favorites.map((res) => (
                                        <RestaurantCard
                                            key={res.id}
                                            restaurant={res}
                                            onClick={() => setActionRestaurant(res)}
                                            surface="favorites"
                                        />
                                    ))}
                                </div>
                            ) : (
                                <EmptyState
                                    icon={<Heart className="w-10 h-10 text-rose-300" />}
                                    title="Sin favoritos"
                                    desc="Guarda los restaurantes que más te gustan para encontrarlos rápido."
                                    action={() => router.push('/')}
                                    btnText="Explorar Ahora"
                                />
                            )}
                        </TabsContent>

                        <TabsContent value="subscriptions" className="space-y-4 focus-visible:outline-none">
                            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 mb-4">
                                <p className="text-xs font-bold text-blue-700 leading-tight">
                                    💡 Recibirás notificaciones push cuando estos restaurantes suban su menú del día o publiquen ofertas flash.
                                </p>
                            </div>
                            {subscriptions.length > 0 ? (
                                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                    {subscriptions.map((res) => (
                                        <RestaurantCard
                                            key={res.id}
                                            restaurant={res}
                                            onClick={() => setActionRestaurant(res)}
                                            surface="favorites"
                                        />
                                    ))}
                                </div>
                            ) : (
                                <EmptyState
                                    icon={<BellRing className="w-10 h-10 text-blue-300" />}
                                    title="Sin suscripciones"
                                    desc="Suscríbete a restaurantes para recibir su menú diario directamente en tu celular."
                                    action={() => router.push('/')}
                                    btnText="Buscar Menús"
                                />
                            )}
                        </TabsContent>
                    </Tabs>
                )}
            </main>

            {selectedRestaurant && (
                <ReservationWizard
                    restaurantId={selectedRestaurant.id}
                    restaurantName={selectedRestaurant.name}
                    onClose={() => setSelectedRestaurant(null)}
                />
            )}

            <RestaurantActionModal
                restaurant={actionRestaurant}
                isOpen={!!actionRestaurant}
                onClose={() => setActionRestaurant(null)}
                onReserve={(r) => setSelectedRestaurant(r)}
            />
        </div>
    );
}

function EmptyState({ icon, title, desc, action, btnText }: any) {
    return (
        <div className="py-20 text-center space-y-6 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm animate-in zoom-in-95 duration-500">
            <div className="bg-slate-50 w-24 h-24 rounded-[2rem] flex items-center justify-center mx-auto border border-slate-100 group-hover:scale-110 transition-transform">
                {icon}
            </div>
            <div className="space-y-2 px-6">
                <h3 className="font-black text-xl text-slate-800">{title}</h3>
                <p className="text-sm text-slate-400 font-medium max-w-[240px] mx-auto leading-tight">
                    {desc}
                </p>
            </div>
            <Button onClick={action} className="rounded-2xl h-14 px-10 font-black text-base shadow-lg shadow-primary/20 bg-primary hover:bg-primary/95 transition-all active:scale-95">
                {btnText}
            </Button>
        </div>
    );
}
