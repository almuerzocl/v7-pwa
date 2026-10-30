"use client";

import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CalendarCheck, ShoppingBag, Store } from 'lucide-react';
import type { RestaurantData } from '@/types';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { trackClientEvent } from '@/lib/client-events';

interface RestaurantActionModalProps {
    restaurant: RestaurantData | null;
    isOpen: boolean;
    onClose: () => void;
    onReserve: (restaurant: RestaurantData) => void;
}

export function RestaurantActionModal({ restaurant, isOpen, onClose, onReserve }: RestaurantActionModalProps) {
    const router = useRouter();
    const restaurantId = restaurant?.id;

    // Abrir las acciones de un local = abrir su perfil (primer paso después de la lista).
    useEffect(() => {
        if (isOpen && restaurantId) trackClientEvent('profile_view', restaurantId, { surface: 'modal' });
    }, [isOpen, restaurantId]);

    if (!restaurant) return null;

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md w-[90vw] rounded-3xl p-6 border-0 shadow-2xl">
                <DialogHeader className="mb-4">
                    <DialogTitle className="text-xl font-black text-center">
                        {restaurant.name}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        Acciones disponibles para {restaurant.name}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    {/* Acción 1: Reservar */}
                    {restaurant.hasReservations && (
                        <Button
                            className="w-full justify-start h-14 rounded-2xl text-base font-bold bg-primary hover:bg-primary/90"
                            onClick={() => {
                                onClose();
                                onReserve(restaurant);
                            }}
                        >
                            <CalendarCheck className="w-5 h-5 mr-3" />
                            Reservar Mesa
                        </Button>
                    )}

                    {/* Acción 2: Pedido para LLevar */}
                    {restaurant.hasTakeaway && (
                        <Button
                            variant="secondary"
                            className="w-full justify-start h-14 rounded-2xl text-base font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200"
                            onClick={() => {
                                onClose();
                                router.push(`/restaurant/${restaurant.id}/menu`);
                            }}
                        >
                            <ShoppingBag className="w-5 h-5 mr-3" />
                            Ver Menú para Llevar
                        </Button>
                    )}

                    {/* Acción 3: Detalles */}
                    <Button
                        variant="outline"
                        className="w-full justify-start h-14 rounded-2xl text-base font-bold mt-2"
                        onClick={() => {
                            onClose();
                            router.push(`/restaurant/${restaurant.id}`);
                        }}
                    >
                        <Store className="w-5 h-5 mr-3" />
                        Ver Detalles del Restaurante
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
