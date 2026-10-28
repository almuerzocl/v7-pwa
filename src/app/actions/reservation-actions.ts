'use server';

import { createClient as createAdminClient } from '@supabase/supabase-js';
import { loadDayInputs, computeDailySlots } from '@/lib/core-business/reservation-slots';

// Use admin client for availability — this is public read-only data
// The SSR cookie client fails when there's no session (unauthenticated users on public homepage)
const supabaseAdmin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function getRestaurantDailyAvailabilityAction(restaurantId: string, dateStr: string, partySize: number = 1) {
    try {
        // Misma lógica que usa el servidor para aceptar la reserva (core-business/reservation-slots.ts)
        const inputs = await loadDayInputs(supabaseAdmin, restaurantId, dateStr);
        const day = computeDailySlots(inputs, dateStr, partySize);
        const data = day.slots.map(({ time, available, occupied, totalCapacity }) => ({ time, available, occupied, totalCapacity }));
        return { success: true, isClosed: day.isClosed, noReservations: !!day.noReservations, data };
    } catch (error: any) {
        console.error('Error fetching availability:', error);
        return { success: false, error: error.message };
    }
}
