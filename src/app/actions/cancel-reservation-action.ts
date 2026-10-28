"use server";

import { createClient } from "@supabase/supabase-js";
import { verifyUser } from "@/utils/supabase/auth-check";

let _supabaseAdmin: ReturnType<typeof createClient> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
    }
    return _supabaseAdmin;
}

const CANCELLABLE_STATUSES = ['CREADA', 'PENDIENTE', 'CONFIRMADA'];
const ONE_HOUR_MS = 60 * 60 * 1000;

export async function cancelReservationAction(reservationId: string, userId: string) {
    const auth = await verifyUser(userId);
    if (!auth.authorized) return { success: false, error: auth.error };

    try {
        // 1. Fetch reservation and verify ownership
        const { data: reservation, error: fetchError } = await supabaseAdmin()
            .from('reservations')
            .select('id, organizer_id, date_time, status, unique_code, restaurant_id, timestamps')
            .eq('id', reservationId)
            .single();

        if (fetchError || !reservation) {
            return { success: false, error: 'Reserva no encontrada' };
        }

        if (reservation.organizer_id !== userId) {
            return { success: false, error: 'Solo el organizador puede cancelar esta reserva' };
        }

        if (!CANCELLABLE_STATUSES.includes(reservation.status)) {
            return { success: false, error: `No se puede cancelar una reserva con estado "${reservation.status}"` };
        }

        // 2. Calculate time until reservation (server-side authoritative check)
        const now = new Date();
        const reservationTime = new Date(reservation.date_time);
        const msUntilReservation = reservationTime.getTime() - now.getTime();
        // Hasta 1 h antes del inicio (inclusive) no penaliza; con menos de 1 h, o ya iniciada, sí.
        const impactsReputation = msUntilReservation < ONE_HOUR_MS;

        // 3. Determine new status
        const newStatus = impactsReputation ? 'NO_SHOW' : 'CANCELADA';
        const reason = impactsReputation
            ? 'Cancelada por el usuario con menos de 1 hora de anticipación'
            : 'Cancelada por el usuario';

        // 4. Update reservation
        const { error: updateError } = await supabaseAdmin()
            .from('reservations')
            .update({
                status: newStatus,
                updated_at: now.toISOString(),
                timestamps: {
                    ...((reservation as any).timestamps || {}),
                    [newStatus]: {
                        at: now.toISOString(),
                        actor_role: 'user',
                        actor_id: userId,
                        reason
                    },
                    cancellation_reason: reason
                }
            })
            .eq('id', reservationId);

        if (updateError) {
            console.error('[cancelReservation] Update error:', updateError);
            return { success: false, error: updateError.message };
        }

        console.log(`[cancelReservation] ${reservation.unique_code} → ${newStatus} (reputation impact: ${impactsReputation})`);

        return {
            success: true,
            newStatus,
            impactsReputation,
            uniqueCode: reservation.unique_code
        };
    } catch (err: any) {
        console.error('[cancelReservation] Exception:', err);
        return { success: false, error: err.message };
    }
}
