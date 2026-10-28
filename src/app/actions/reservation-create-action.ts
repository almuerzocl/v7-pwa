"use server";

import { createClient } from "@supabase/supabase-js";
import { verifyUser } from "@/utils/supabase/auth-check";
import { validateReservationSlot, MESSAGES as SLOT_MESSAGES } from "@/lib/core-business/reservation-slots";
import { formatInTimeZone } from "date-fns-tz";
import { revalidateChosenDiscount, composeNotes, droppedDiscountMessage } from "@/lib/core-business/discount-checkout";
import type { InstitutionDiscount } from "@/lib/core-business/discounts";
import { limitInfoFromDbError, limitReachedMessage, LIMIT_REACHED, parseLimitInfo } from "@/lib/operation-limits";
import { processReservationConfirmations } from "@/lib/server/reservation-confirmation";

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

export async function createReservationAction(data: {
    restaurant_id: string;
    organizer_id: string;
    date_time: string;
    status?: string;  // kept for API compat but always PENDIENTE — enforced in DB function
    payment_method: string;
    title: string;
    guest_ids: string[];
    guest_data: any[];
    guests: any[];
    party_size: number;
    organizer_reputation_snapshot: number;
    user_total_reservations_snapshot: number;
    discount_data_snapshot: any;
    applied_discount_id: string | null;
    account_type_snapshot: string;
    benefits_snapshot: any;
    special_requests: string;
    unique_code: string;
    timestamps: any;
}) {
    const auth = await verifyUser(data.organizer_id);
    if (!auth.authorized) return { success: false, reservation: null, error: auth.error };

    try {
        // El servidor es quien decide si el horario existe y tiene mesa (no basta con que la pantalla lo ofrezca:
        // un cliente desactualizado o una llamada directa se la saltan). Mismas reglas que la pantalla de
        // disponibilidad: restaurante activo, día y turno abiertos, hora futura y mesa libre.
        const slotCheck = await validateReservationSlot(supabaseAdmin(), {
            restaurantId: data.restaurant_id,
            dateTime: data.date_time,
            partySize: data.party_size,
        });
        if (!slotCheck.ok) {
            console.warn(`[createReservation] Horario rechazado (${slotCheck.code}) restaurant=${data.restaurant_id} date_time=${data.date_time}`);
            return { success: false, reservation: null, error: slotCheck.message, slotRejected: slotCheck.code };
        }

        // Descuento: se revalida AQUÍ (servidor, antes de insertar) contra almuerzo-discounts. Si ya no es vigente
        // o el servicio no responde, la reserva se crea SIN descuento (sin applied_discount_id ni observación) y
        // se avisa al cliente; nunca se bloquea.
        const discountOutcome = await revalidateChosenDiscount({
            userId: data.organizer_id,
            restaurantId: data.restaurant_id,
            serviceType: 'reservation',
            date: formatInTimeZone(new Date(data.date_time), 'America/Santiago', 'yyyy-MM-dd'),
            appliedDiscountId: data.applied_discount_id,
            snapshot: data.discount_data_snapshot,
        });
        const appliedDiscount = discountOutcome.discount;
        const withOrganizerDiscount = (list: any[]) =>
            (list ?? []).map((g) => (g?.is_organizer ? { ...g, selected_discount: selectedDiscountOf(appliedDiscount) } : g));

        // La reputación que decide la aprobación automática se lee AQUÍ, en el servidor, de la base (`effective_reputation`, migración 041):
        // la real del perfil (que calcula la BD una vez al día, migración 020) o 100 si la cuenta es ELITE vigente. Nunca se confía en la
        // que envía el navegador (organizer_reputation_snapshot): un cliente modificado podría declarar 100.
        // Si no se puede leer, se asume 0 (falla cerrado: queda PENDIENTE para aprobación manual).
        const { data: repValue } = await (supabaseAdmin() as any).rpc('effective_reputation', { p_user: data.organizer_id, p_scope: 'reservation' });
        const serverReputation: number = typeof repValue === 'number' ? repValue : 0;

        // Atomic capacity check + INSERT via DB function.
        // pg_advisory_xact_lock inside the function serializes concurrent requests
        // for the same restaurant+slot, preventing overbooking under load.
        const { data: result, error: rpcError } = await supabaseAdmin().rpc('create_reservation_atomic', {
            p_restaurant_id: data.restaurant_id,
            p_organizer_id: data.organizer_id,
            p_date_time: data.date_time,
            p_party_size: data.party_size,
            p_reservation_data: {
                payment_method: data.payment_method,
                title: data.title,
                guest_ids: data.guest_ids,
                guest_data: withOrganizerDiscount(data.guest_data),
                guests: withOrganizerDiscount(data.guests),
                organizer_reputation_snapshot: serverReputation,
                user_total_reservations_snapshot: data.user_total_reservations_snapshot,
                discount_data_snapshot: discountOutcome.dropped ? [] : data.discount_data_snapshot,
                applied_discount_id: appliedDiscount?.discount_id ?? null,
                account_type_snapshot: data.account_type_snapshot,
                benefits_snapshot: data.benefits_snapshot,
                special_requests: composeNotes(data.special_requests, appliedDiscount),
                unique_code: data.unique_code,
                timestamps: data.timestamps,
            },
        });

        if (rpcError) {
            // Respaldo del tope (el trigger de la base): mismo mensaje y código que la respuesta normal.
            if (rpcError.hint === LIMIT_REACHED) {
                const info = limitInfoFromDbError(rpcError);
                return { success: false, reservation: null, error: limitReachedMessage(info), limitReached: info };
            }
            if (rpcError.hint === 'outside_reservation_window') {
                return { success: false, reservation: null, error: SLOT_MESSAGES.OUTSIDE_RESERVATION_WINDOW, slotRejected: 'OUTSIDE_RESERVATION_WINDOW' };
            }
            console.error('[createReservation] RPC error:', rpcError);
            return { success: false, reservation: null, error: rpcError.message };
        }

        if ((result as any)?.code === LIMIT_REACHED) {
            const info = parseLimitInfo(result);
            return { success: false, reservation: null, error: limitReachedMessage(info), limitReached: info };
        }

        // Respaldo de la ventana de reservas (la regla de la base, migración 045b): la app ya la valida arriba.
        if ((result as any)?.code === 'outside_reservation_window') {
            return { success: false, reservation: null, error: SLOT_MESSAGES.OUTSIDE_RESERVATION_WINDOW, slotRejected: 'OUTSIDE_RESERVATION_WINDOW' };
        }

        if (!result?.success) {
            const errMsg = result?.error ?? 'Error al crear la reserva';
            console.warn('[createReservation] Rejected by DB:', errMsg, `remaining=${result?.remaining_seats}`);
            return {
                success: false,
                reservation: null,
                error: errMsg,
                remainingSeats: result?.remaining_seats ?? 0,
            };
        }

        const reservation = { id: result.id, unique_code: result.unique_code };
        console.log(`[createReservation] Created atomically: ${reservation.unique_code} for restaurant ${data.restaurant_id}`);

        // La aprobación automática la decide UN solo actor: el trigger auto_approve_reservation de la BD
        // (migración 023), con los parámetros del restaurante (max_party_size + min_reputation, criterios
        // concurrentes) y la reputación del organizador. Esta acción no decide nada: solo informa el
        // estado con el que quedó la reserva.
        const { data: created } = await supabaseAdmin()
            .from('reservations')
            .select('status')
            .eq('id', reservation.id)
            .maybeSingle();
        const autoApproved = (created as any)?.status === 'CONFIRMADA';
        if (autoApproved) {
            console.log(`[AutoApproval] Reservation ${reservation.unique_code} auto-confirmed by DB trigger`);
            // Aviso en línea (no espera al cron de 1 min). Se espera aquí porque Cloud Run estrangula la CPU tras
            // responder. Si falla, no afecta a la reserva: el reclamo se libera y el cron reintenta.
            try {
                await processReservationConfirmations({ id: reservation.id });
            } catch (e) {
                console.error('[createReservation] Aviso en línea falló; lo reintenta el cron:', e);
            }
        }

        return {
            success: true,
            reservation,
            autoApproved,
            ...(discountOutcome.dropped && {
                discountDropped: { reason: discountOutcome.dropped.reason, message: droppedDiscountMessage(discountOutcome.dropped, 'reservation') },
            }),
        };
    } catch (err: any) {
        console.error('[createReservation] Exception:', err);
        return { success: false, reservation: null, error: err.message };
    }
}

function selectedDiscountOf(d: InstitutionDiscount | null) {
    return d
        ? {
            id: d.discount_id,
            name: `${d.institution_name} - ${d.discount_name}`,
            percentage: d.amount_type === 'percent' ? d.amount : 0,
        }
        : null;
}
