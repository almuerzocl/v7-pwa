import { format } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/config';

export type ServiceType = 'reservation' | 'takeaway';

/**
 * Checks if a specific timeslot has capacity for a given party size.
 * Validates against physical seats (reservations) or kitchen slots (takeaway).
 */
export async function checkCapacity(
    restaurantId: string,
    date: Date,
    timeStr: string,
    partySize: number,
    serviceType: ServiceType = 'reservation'
): Promise<{ isAvailable: boolean; remainingSeats?: number }> {
    try {
        const dateStr = format(date, 'yyyy-MM-dd');
        // Construct Santiago Time
        const santiagoTimeStr = `${dateStr} ${timeStr}:00`;
        const slotTime = fromZonedTime(santiagoTimeStr, TIMEZONE);

        // La consulta pasa por /api/availability (el servidor ejecuta check_restaurant_availability
        // con la sesión validada); el navegador ya no llama a la función de la base.
        const qs = new URLSearchParams({
            restaurantId,
            time: slotTime.toISOString(),
            partySize: String(partySize),
        });
        const res = await fetch(`/api/availability?${qs}`, { credentials: 'same-origin' });
        const json = await res.json().catch(() => null);

        if (!res.ok || !json?.ok) {
            console.error('[Business Logic] Error checking capacity:', json?.reason ?? res.status);
            // Fallback to allow if the check fails, prevent blocking due to tech error
            // (create_reservation_atomic revalida el cupo al crear la reserva).
            return { isAvailable: true };
        }

        return {
            isAvailable: json.isAvailable ?? true,
            remainingSeats: json.remainingSeats ?? 0,
        };
    } catch (err) {
        console.error('[Business Logic] Crash calculating capacity:', err);
        return { isAvailable: true };
    }
}
