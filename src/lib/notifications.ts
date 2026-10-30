// packages/pwa/lib/notifications.ts
// Solo el AVISO INTERNO al restaurante (notificación en la base). Ningún correo ni SMS sale desde el
// navegador: los correos de reservas y pedidos los envía el servidor al confirmarse/aprobarse
// (src/lib/server/reservation-confirmation.ts y order-confirmation.ts).
'use client';


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
 * Internal notification for Restaurant Admin (DB)
 */
export async function notifyRestaurantAdmin(data: NotificationData) {
    try {
        console.log(`🔔 Notifying restaurant admin about ${data.type}...`, data.restaurantId);

        // 1. Persistent Notification (DB)
        // Server action (service_role): valida que el registro sea del usuario y deriva
        // restaurante/texto de la BD. La RPC notify_restaurant_admins ya no es ejecutable desde cliente.
        const dbResult = await notifyRestaurantNewBookingAction({ type: data.type, resourceId: data.id });
        if (!dbResult.success) {
            console.error('Error notifying restaurant staff:', dbResult.error);
        }

        return { success: true };
    } catch (error) {
        console.error('Failed to notify restaurant admin:', error);
        return { success: false, error };
    }
}
