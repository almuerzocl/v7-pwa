"use server";

import { createClient as createSessionClient } from "@/utils/supabase/server";
import { getSupabaseAdmin } from "@/lib/server/supabase-admin";
import { sendEmail } from "@/lib/server/email";
import { processReservationConfirmations } from "@/lib/server/reservation-confirmation";
import { rateLimit } from "@/lib/rate-limit";
import { addGuestsToReservation, type GuestInput, type AddGuestsResult } from "@/lib/server/add-reservation-guests";
import { matchExistingUserAction } from "@/app/actions/guests-actions";

/**
 * El organizador agrega invitados a una reserva ya creada. La sesión se valida con auth.getUser(); la regla de
 * organizador, cupo, hora y estado la aplica el RPC `add_reservation_guests` (solo service_role).
 */
export async function addReservationGuestsAction(reservationId: string, guests: GuestInput[]): Promise<AddGuestsResult> {
    const session = await createSessionClient();
    const { data: { user } } = await session.auth.getUser();
    if (!user) return { success: false, error: "Tu sesión expiró. Inicia sesión nuevamente." };

    const { allowed } = rateLimit(`add-guests:${user.id}`, 10, 60_000);
    if (!allowed) return { success: false, error: "Demasiados intentos. Espera un minuto." };

    const clean: GuestInput[] = (Array.isArray(guests) ? guests : []).map((g) => ({
        id: String(g?.id ?? ""),
        name: String(g?.name ?? "").slice(0, 120),
        email: g?.email ? String(g.email).slice(0, 200) : null,
        phone: g?.phone ? String(g.phone).slice(0, 32) : null,
    }));

    return addGuestsToReservation(user.id, reservationId, clean, {
        admin: getSupabaseAdmin(),
        matchUser: matchExistingUserAction,
        send: (p) => sendEmail(p) as Promise<{ success: boolean; error?: string }>,
        processConfirmations: (id) => processReservationConfirmations({ id }),
    });
}
