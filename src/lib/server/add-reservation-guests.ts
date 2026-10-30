/**
 * Agregar invitados a una reserva ya creada (solo el organizador, hasta la hora de la reserva).
 * Módulo de SERVIDOR sin 'use server': la acción pública vive en `app/actions/add-guests-action.ts`.
 *
 * Mismo camino que el wizard: el RPC `add_reservation_guests` (migración 049) valida cupo y reglas, deja al
 * invitado en guest_data/guests y reabre el aviso; el emisor de invitaciones (`processReservationConfirmations`)
 * envía a cada invitado con correo su enlace personal, solo con la reserva CONFIRMADA. Si el aumento supera
 * `max_party_size`, la reserva vuelve a PENDIENTE y se avisa por correo al organizador.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { escapeHtml } from '@/lib/email-ticket-html';
import { TIMEZONE } from '@/lib/config';

export interface GuestInput {
    id: string;
    name: string;
    email?: string | null;
    phone?: string | null;
}

export interface AddGuestsDeps {
    admin: SupabaseClient<any>;
    matchUser: (email?: string, phone?: string) => Promise<string | null>;
    send: (p: { to: string; subject: string; text: string; html: string }) => Promise<{ success: boolean; error?: string }>;
    processConfirmations: (id: string) => Promise<unknown>;
}

export type AddGuestsResult =
    | { success: true; needsApproval: boolean; partySize: number; previousPartySize: number; noticeSent: boolean | null }
    | { success: false; code?: string; error: string };

const MESSAGES: Record<string, string> = {
    not_found: 'No encontramos la reserva.',
    not_organizer: 'Solo el organizador puede agregar invitados.',
    not_editable: 'Esta reserva ya no admite nuevos invitados.',
    past: 'La hora de la reserva ya pasó.',
    plan_blocked: 'Este local no está recibiendo reservas por el momento.',
    duplicate_guest: 'Uno de los invitados ya está en la reserva.',
    invalid_guests: 'Revisa los datos de los invitados (nombre obligatorio, hasta 10 a la vez).',
};

export function mapAddGuestsError(code: string | undefined, remaining?: number, fallback?: string): string {
    if (code === 'no_capacity') {
        return remaining && remaining > 0
            ? `El restaurante solo tiene ${remaining} ${remaining === 1 ? 'cupo' : 'cupos'} disponible${remaining === 1 ? '' : 's'} en ese horario.`
            : 'El restaurante no tiene cupos disponibles en ese horario para sumar invitados.';
    }
    return (code && MESSAGES[code]) || fallback || 'No se pudo agregar a los invitados.';
}

export function buildApprovalNotice(p: { firstName: string; restaurantName: string; when: string; from: number; to: number; code: string }) {
    const esc = escapeHtml;
    const subject = `Tu reserva en ${p.restaurantName} está sujeta a aprobación`;
    const text = `Hola${p.firstName ? ` ${p.firstName}` : ''}. Agregaste invitados a tu reserva en ${p.restaurantName} para el ${p.when}: pasó de ${p.from} a ${p.to} personas. ` +
        `Como supera el tamaño que el restaurante confirma automáticamente, ahora está sujeta a su aprobación. Te avisaremos cuando la responda. ` +
        `Tus invitados nuevos recibirán su invitación solo cuando se confirme. Si el restaurante no puede aceptar el aumento, tu reserva se mantiene confirmada para ${p.from} personas. Código: ${p.code}.`;
    const html = `
<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 16px;background-color:#f1f5f9;color:#1a1a1a;">
    <div style="text-align:center;margin-bottom:20px;"><span style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:4px;color:#64748b;">Almuerzo.cl</span></div>
    <table width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:24px;box-shadow:0 8px 40px rgba(0,0,0,0.12);"><tr><td style="padding:32px 28px;">
        <p style="margin:0 0 12px 0;font-size:15px;font-weight:700;color:#334155;">Hola${p.firstName ? ` ${esc(p.firstName)}` : ''}.</p>
        <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#334155;">Agregaste invitados a tu reserva en <strong>${esc(p.restaurantName)}</strong> para el <strong>${esc(p.when)}</strong>: pasó de <strong>${p.from}</strong> a <strong>${p.to}</strong> personas.</p>
        <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#334155;">Como supera el tamaño que el restaurante confirma automáticamente, <strong>ahora está sujeta a su aprobación</strong>. Te avisaremos cuando la responda.</p>
        <p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;color:#475569;">Tus invitados nuevos recibirán su invitación solo cuando se confirme. Si el restaurante no puede aceptar el aumento, tu reserva se mantiene confirmada para ${p.from} personas.</p>
        <p style="margin:16px 0 0 0;font-size:12px;color:#94a3b8;">Código de reserva: ${esc(p.code)}</p>
    </td></tr></table>
</div>`;
    return { subject, text, html };
}

export async function addGuestsToReservation(
    userId: string,
    reservationId: string,
    guests: GuestInput[],
    deps: AddGuestsDeps,
): Promise<AddGuestsResult> {
    const { admin } = deps;
    if (!reservationId || !Array.isArray(guests) || guests.length < 1 || guests.length > 10) {
        return { success: false, code: 'invalid_guests', error: mapAddGuestsError('invalid_guests') };
    }

    // Vincula a cada invitado con su cuenta si ya existe (igual que el wizard): así le aparece en "Mis reservas".
    const prepared = [];
    for (const g of guests) {
        const linked = await deps.matchUser(g.email || undefined, g.phone || undefined).catch(() => null);
        prepared.push({ id: g.id, name: g.name, email: g.email || null, phone: g.phone || null, user_id: linked });
    }

    const { data, error } = await admin.rpc('add_reservation_guests', {
        p_reservation_id: reservationId,
        p_actor_id: userId,
        p_guests: prepared,
    });
    if (error) return { success: false, error: 'No se pudo agregar a los invitados. Intenta de nuevo.' };
    const res = data as any;
    if (!res?.success) return { success: false, code: res?.code, error: mapAddGuestsError(res?.code, res?.remaining_seats, res?.error) };

    const needsApproval = !!res.needs_approval;
    let noticeSent: boolean | null = null;

    if (needsApproval) {
        try {
            const [{ data: row }, { data: profile }] = await Promise.all([
                admin.from('reservations').select('date_time, unique_code, restaurant:restaurants(name)').eq('id', reservationId).maybeSingle(),
                admin.from('profiles').select('email, first_name').eq('id', userId).maybeSingle(),
            ]);
            const to = (profile?.email as string | undefined)?.trim();
            if (!row || !to) {
                noticeSent = false;
            } else {
                const when = format(toZonedTime(new Date(row.date_time), TIMEZONE), "EEEE d 'de' MMMM 'a las' HH:mm", { locale: es });
                const n = buildApprovalNotice({
                    firstName: (profile?.first_name as string) || '',
                    restaurantName: (row as any).restaurant?.name || 'el restaurante',
                    when, from: res.previous_party_size, to: res.party_size, code: String(row.unique_code || '').toUpperCase(),
                });
                const sent = await deps.send({ to, ...n });
                noticeSent = !!sent.success;
                if (!sent.success) console.error('[addGuests] No se pudo enviar el aviso de aprobación:', sent.error);
            }
        } catch (e) {
            noticeSent = false;
            console.error('[addGuests] Falló el aviso de aprobación:', e);
        }
    } else {
        // Aviso en línea (no espera al cron de 1 min). Si falla, el cron reintenta: el reclamo se libera.
        try { await deps.processConfirmations(reservationId); } catch (e) { console.error('[addGuests] Aviso en línea falló; lo reintenta el cron:', e); }
    }

    return { success: true, needsApproval, partySize: res.party_size, previousPartySize: res.previous_party_size, noticeSent };
}
