// packages/pwa/lib/notifications.ts
// Solo el AVISO INTERNO al restaurante (notificación en la base + señal en vivo). Ningún correo ni SMS sale desde el
// navegador: los correos de reservas y pedidos los envía el servidor al confirmarse/aprobarse
// (src/lib/server/reservation-confirmation.ts y order-confirmation.ts).
'use client';

import { supabase } from '@/lib/supabase';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface NotificationData {
    id: string;
    uniqueCode?: string;
    restaurantId: string;
    restaurantName: string;
    restaurantAddress?: string;
    dateTime: string;
    partySize?: number;
    itemCount?: number;
    totalAmount?: number;
    guestName: string;
    guestEmail: string;
    guestPhone?: string;
    type: 'reservation' | 'order';
    guests?: NotificationGuest[];
}

import { notifyRestaurantNewBookingAction } from '@/app/actions/restaurant-notify-action';
import type { NotificationGuest } from './email-ticket-html';

/**
 * Internal notification for Restaurant Admin (Realtime / DB)
 */
export async function notifyRestaurantAdmin(data: NotificationData) {
    try {
        const start = new Date(data.dateTime);
        const displayDate = isNaN(start.getTime())
            ? data.dateTime
            : format(start, "EEEE d 'de' MMMM 'a las' HH:mm 'hrs'", { locale: es });

        console.log(`🔔 Notifying restaurant admin about ${data.type}...`, data.restaurantId);
        const title = data.type === 'reservation' ? 'Nueva Reserva Recibida 🍽️' : 'Nuevo Pedido Takeaway 🥡';
        const message = data.type === 'reservation'
            ? `${data.guestName} reservó para ${data.partySize} personas el ${displayDate}`
            : `${data.guestName} realizó un pedido de ${data.itemCount} items`;

        // 1. Persistent Notification (DB)
        // Server action (service_role): valida que el registro sea del usuario y deriva
        // restaurante/texto de la BD. La RPC notify_restaurant_admins ya no es ejecutable desde cliente.
        const dbResult = await notifyRestaurantNewBookingAction({ type: data.type, resourceId: data.id });
        if (!dbResult.success) {
            console.error('Error notifying restaurant staff:', dbResult.error);
        }

        // 2. Realtime Signal (Direct Broadcast for immediate Dashboard update)
        await new Promise<void>((resolve) => {
            const safetyTimer = setTimeout(resolve, 3000);
            const signalChannel = supabase.channel(`restaurant-signals-${data.restaurantId}`);
            signalChannel.subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await signalChannel.send({
                        type: 'broadcast',
                        event: 'new_notification',
                        payload: {
                            type: data.type,
                            title,
                            message,
                            restaurantId: data.restaurantId,
                            id: data.id
                        }
                    });
                    console.log('📡 Realtime broadcast sent to restaurant', data.restaurantId);
                    clearTimeout(safetyTimer);
                    setTimeout(() => supabase.removeChannel(signalChannel), 1000);
                    resolve();
                }
            });
        });

        return { success: true };
    } catch (error) {
        console.error('Failed to notify restaurant admin:', error);
        return { success: false, error };
    }
}
