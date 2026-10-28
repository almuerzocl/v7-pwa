import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { PWA_URL, TICKET_URL, TIMEZONE } from '@/lib/config';
import { buildTicketEmailHtml, escapeHtml } from '@/lib/email-ticket-html';
import { sendGoogleCalendarInvitation } from '@/lib/invitations';
import { sendEmail } from '@/lib/server/email';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';

/**
 * EMISOR ÚNICO de los correos de una reserva (migración 031).
 *
 * Regla de negocio: el correo de confirmación (organizador) y las invitaciones (invitados) salen UNA sola vez y
 * solo cuando la reserva está CONFIRMADA, venga de la autoaprobación, de la aprobación manual del restaurante o
 * de una reserva creada por el restaurante. PENDIENTE, rechazada o cancelada antes de confirmarse no envía nada;
 * tampoco una reserva cuya hora ya pasó.
 *
 * Idempotencia: claim_reservation_confirmations() reclama filas CONFIRMADA con la marca vacía en forma atómica
 * (FOR UPDATE SKIP LOCKED); dos ejecuciones simultáneas nunca toman la misma. `confirmation_sent` registra a quién
 * ya se le envió, de modo que un reintento solo repite lo que faltó. Con todo enviado se fija
 * `confirmation_notified_at`; si algo falla se libera el reclamo (reintento en la próxima ejecución, tope de 5
 * intentos en la función SQL) y el error queda en error_logs.
 */

export const MAX_NOTIFY_ATTEMPTS = 5;

type Row = Record<string, any>;

export interface ConfirmationDeps {
    admin: ReturnType<typeof getSupabaseAdmin>;
    send: (p: { to: string; subject: string; text: string; html: string }) => Promise<{ success: boolean; error?: string }>;
    now: () => Date;
}

export interface ConfirmationSummary {
    claimed: number;
    completed: number;
    emailsSent: number;
    failed: number;
    skipped: number;
}

function defaultDeps(): ConfirmationDeps {
    return {
        admin: getSupabaseAdmin(),
        // rateLimitKey = correo del destinatario: no es UUID, así que no cuenta contra el límite diario por usuario.
        send: (p) => sendEmail({ ...p, rateLimitKey: p.to }),
        now: () => new Date(),
    };
}

async function logError(admin: ConfirmationDeps['admin'], message: string, metadata: Row) {
    try {
        await admin.from('error_logs').insert({ app: 'pwa', source: 'reservation-confirmation', severity: 'error', message, metadata });
    } catch { /* no bloqueante */ }
}

function personName(p: Row | null | undefined): string {
    if (!p) return '';
    return (p.display_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || '').trim();
}

/** Procesa las reservas CONFIRMADA pendientes de aviso. `id` limita a una reserva (aviso en línea). */
export async function processReservationConfirmations(
    opts: { id?: string; limit?: number } = {},
    deps: ConfirmationDeps = defaultDeps(),
): Promise<ConfirmationSummary> {
    const { admin, send } = deps;
    const summary: ConfirmationSummary = { claimed: 0, completed: 0, emailsSent: 0, failed: 0, skipped: 0 };

    const { data: claimed, error: claimError } = await admin.rpc('claim_reservation_confirmations', {
        p_limit: opts.limit ?? 20,
        p_id: opts.id ?? null,
    });
    if (claimError) {
        await logError(admin, `No se pudo reclamar confirmaciones: ${claimError.message}`, { id: opts.id ?? null });
        throw new Error(claimError.message);
    }

    for (const row of (claimed ?? []) as Row[]) {
        summary.claimed++;
        try {
            const result = await notifyOne(row, deps);
            summary.emailsSent += result.sent;
            if (result.status === 'completed') summary.completed++;
            else if (result.status === 'skipped') summary.skipped++;
            else summary.failed++;
        } catch (err: any) {
            summary.failed++;
            await release(admin, row.id);
            await logError(admin, `Falló el aviso de la reserva ${row.unique_code}: ${err?.message ?? err}`, {
                reservation_id: row.id,
                attempt: row.confirmation_notify_attempts,
            });
        }
    }
    return summary;
}

async function release(admin: ConfirmationDeps['admin'], id: string) {
    await admin.from('reservations').update({ confirmation_notify_claimed_at: null }).eq('id', id);
}

async function notifyOne(row: Row, deps: ConfirmationDeps): Promise<{ status: 'completed' | 'skipped' | 'failed'; sent: number }> {
    const { admin, send, now } = deps;

    // El estado puede haber cambiado entre el reclamo y el envío (p. ej. el restaurante cancela): se relee.
    const { data: fresh } = await admin.from('reservations').select('status, date_time, cancellation_reason').eq('id', row.id).maybeSingle();
    if (!fresh || fresh.status !== 'CONFIRMADA' || new Date(fresh.date_time).getTime() <= now().getTime()) {
        await release(admin, row.id);
        return { status: 'skipped', sent: 0 };
    }

    const [{ data: restaurant }, { data: organizerProfile }] = await Promise.all([
        admin.from('restaurants').select('name, address').eq('id', row.restaurant_id).maybeSingle(),
        row.organizer_id
            ? admin.from('profiles').select('email, first_name, last_name, display_name').eq('id', row.organizer_id).maybeSingle()
            : Promise.resolve({ data: null }),
    ]);

    const restaurantName: string = restaurant?.name || 'el restaurante';
    const guestData: Row[] = Array.isArray(row.guest_data) ? row.guest_data : [];
    const organizerEntry = guestData.find((g) => g?.is_organizer) ?? guestData.find((g) => g?.is_manual) ?? null;
    const organizerEmail: string | null = (organizerEntry?.email || organizerProfile?.email || null)?.trim() || null;
    const organizerName: string = organizerEntry?.name || personName(organizerProfile) || 'El organizador';

    const code: string = String(row.unique_code || row.id.split('-')[0]).toUpperCase();
    const ticketUrl = `${TICKET_URL}/r/${row.unique_code || row.id}`;
    const start = new Date(row.date_time);
    const zoned = toZonedTime(start, TIMEZONE);
    const displayDate = format(zoned, 'eee d MMM', { locale: es });
    const displayTime = format(zoned, 'HH:mm');
    const longDate = format(zoned, "EEEE d MMMM, HH:mm", { locale: es });
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    const calendarUrl = await sendGoogleCalendarInvitation({
        title: `Reserva en ${restaurantName}`,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        description: `Reserva en ${restaurantName}.`,
        location: restaurantName,
        cardLink: ticketUrl,
    }).catch(() => '');

    const people = guestData.map((g, i) => ({
        key: g?.is_organizer || g === organizerEntry ? 'organizer' : `g:${g?.id ?? `i${i}`}`,
        id: g?.id as string | undefined,
        name: (g?.name as string) || 'Invitado',
        email: (g?.email as string | null) || null,
        status: (g?.status as string) || 'PENDIENTE',
        isOrganizer: g === organizerEntry,
    }));
    const guestsForTemplate = people.map((p) => ({ id: p.id, name: p.name, email: p.email, status: p.status, is_organizer: p.isOrganizer }));
    const partySize: number = row.party_size ?? people.length;

    const sentMap: Record<string, boolean> = { ...(row.confirmation_sent ?? {}) };
    let sent = 0;
    let pendingFailures = 0;
    const errors: string[] = [];

    const attempt = async (key: string, to: string, subject: string, text: string, html: string) => {
        if (sentMap[key]) return;
        const res = await send({ to, subject, text, html });
        if (res.success) {
            sentMap[key] = true;
            sent++;
            await admin.from('reservations').update({ confirmation_sent: sentMap }).eq('id', row.id);
        } else {
            pendingFailures++;
            errors.push(`${key}: ${res.error ?? 'error desconocido'}`);
        }
    };

    // 1) Confirmación al organizador.
    if (organizerEmail) {
        const html = buildTicketEmailHtml({
            type: 'reservation', restaurantName, restaurantAddress: restaurant?.address || undefined, ticketCode: code,
            displayDate, displayTime, partySize, guests: guestsForTemplate, ticketUrl,
            recipientFirstName: organizerName.split(' ')[0] || organizerName, isPersonalInvite: false,
            calendarGoogleUrl: calendarUrl || undefined,
        });
        await attempt(
            'organizer', organizerEmail, `Reserva confirmada en ${restaurantName}`,
            `Reserva confirmada en ${restaurantName}. Fecha: ${displayDate} ${displayTime}. Código: ${code}. Ver ticket: ${ticketUrl}`, html,
        );
    }

    // 2) Una invitación por invitado con correo (no el organizador, ni un correo repetido).
    const seen = new Set<string>(organizerEmail ? [organizerEmail.toLowerCase()] : []);
    for (const p of people) {
        if (p.isOrganizer || !p.email) continue;
        const lower = p.email.trim().toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        const respond = p.id ? `${TICKET_URL}/v/${row.unique_code}?g=${p.id}` : null;
        const html = buildTicketEmailHtml({
            type: 'reservation', restaurantName, restaurantAddress: restaurant?.address || undefined, ticketCode: code,
            displayDate, displayTime, partySize, guests: guestsForTemplate, ticketUrl,
            recipientFirstName: p.name.split(' ')[0] || p.name, isPersonalInvite: true, organizerName,
            rsvpConfirmUrl: respond ? `${respond}&a=confirm` : undefined,
            rsvpCancelUrl: respond ? `${respond}&a=decline` : undefined,
            calendarGoogleUrl: calendarUrl || undefined,
        });
        await attempt(
            p.key, p.email, `Has sido invitado a almorzar con ${organizerName} en ${restaurantName}`,
            `Reserva en ${restaurantName} el ${longDate}. Ver ticket: ${ticketUrl}`, html,
        );
    }

    if (pendingFailures === 0) {
        await admin.from('reservations').update({
            confirmation_notified_at: now().toISOString(), confirmation_notify_claimed_at: null, confirmation_sent: sentMap,
        }).eq('id', row.id);
        return { status: 'completed', sent };
    }

    await release(admin, row.id);
    const attemptNo: number = row.confirmation_notify_attempts ?? 1;
    await logError(
        admin,
        `Aviso de la reserva ${code} incompleto (intento ${attemptNo}/${MAX_NOTIFY_ATTEMPTS})${attemptNo >= MAX_NOTIFY_ATTEMPTS ? ': SE ABANDONA' : ''}: ${errors.join('; ')}`,
        { reservation_id: row.id, attempt: attemptNo, gave_up: attemptNo >= MAX_NOTIFY_ATTEMPTS },
    );
    return { status: 'failed', sent };
}


// ─── AVISO DE RECHAZO (migración 032) ────────────────────────────────────────────────────────────────────────────
// Regla (usuario, 2026-10-06): si el restaurante RECHAZA la reserva se informa SOLO al organizador, una vez y solo si la
// hora aún no pasó. Una reserva PENDIENTE no envía nada y los invitados nunca reciben este aviso.

export async function processReservationRejections(
    opts: { id?: string; limit?: number } = {},
    deps: ConfirmationDeps = defaultDeps(),
): Promise<ConfirmationSummary> {
    const { admin } = deps;
    const summary: ConfirmationSummary = { claimed: 0, completed: 0, emailsSent: 0, failed: 0, skipped: 0 };

    const { data: claimed, error: claimError } = await admin.rpc('claim_reservation_rejections', {
        p_limit: opts.limit ?? 20,
        p_id: opts.id ?? null,
    });
    if (claimError) {
        await logError(admin, `No se pudo reclamar rechazos: ${claimError.message}`, { id: opts.id ?? null });
        throw new Error(claimError.message);
    }

    for (const row of (claimed ?? []) as Row[]) {
        summary.claimed++;
        try {
            const result = await rejectOne(row, deps);
            summary.emailsSent += result.sent;
            if (result.status === 'completed') summary.completed++;
            else if (result.status === 'skipped') summary.skipped++;
            else summary.failed++;
        } catch (err: any) {
            summary.failed++;
            await admin.from('reservations').update({ rejection_notify_claimed_at: null }).eq('id', row.id);
            await logError(admin, `Falló el aviso de rechazo de la reserva ${row.unique_code}: ${err?.message ?? err}`, {
                reservation_id: row.id,
                attempt: row.rejection_notify_attempts,
            });
        }
    }
    return summary;
}

async function rejectOne(row: Row, deps: ConfirmationDeps): Promise<{ status: 'completed' | 'skipped' | 'failed'; sent: number }> {
    const { admin, send, now } = deps;
    const releaseClaim = () => admin.from('reservations').update({ rejection_notify_claimed_at: null }).eq('id', row.id);

    // Se relee: el estado pudo cambiar entre el reclamo y el envío.
    const { data: fresh } = await admin.from('reservations').select('status, date_time, cancellation_reason').eq('id', row.id).maybeSingle();
    if (!fresh || fresh.status !== 'RECHAZADA' || new Date(fresh.date_time).getTime() <= now().getTime()) {
        await releaseClaim();
        return { status: 'skipped', sent: 0 };
    }

    const [{ data: restaurant }, { data: organizerProfile }] = await Promise.all([
        admin.from('restaurants').select('name').eq('id', row.restaurant_id).maybeSingle(),
        row.organizer_id
            ? admin.from('profiles').select('email, first_name, last_name, display_name').eq('id', row.organizer_id).maybeSingle()
            : Promise.resolve({ data: null }),
    ]);
    const guestData: Row[] = Array.isArray(row.guest_data) ? row.guest_data : [];
    const organizerEntry = guestData.find((g) => g?.is_organizer) ?? guestData.find((g) => g?.is_manual) ?? null;
    const to: string | null = (organizerEntry?.email || organizerProfile?.email || null)?.trim() || null;
    if (!to) {
        // Sin correo del organizador no hay a quién avisar: se cierra para no reintentar.
        await admin.from('reservations').update({ rejection_notified_at: now().toISOString(), rejection_notify_claimed_at: null }).eq('id', row.id);
        return { status: 'skipped', sent: 0 };
    }

    const restaurantName: string = restaurant?.name || 'el restaurante';
    const name = organizerEntry?.name || personName(organizerProfile) || '';
    const when = format(toZonedTime(new Date(row.date_time), TIMEZONE), "EEEE d 'de' MMMM 'a las' HH:mm", { locale: es });
    const reason: string | null = (fresh.cancellation_reason as string | null)?.trim() || null;
    const code = String(row.unique_code || '').toUpperCase();

    const html = buildRejectionEmailHtml({ restaurantName, firstName: name.split(' ')[0] || name, when, reason, code });
    const text = `Tu solicitud de reserva en ${restaurantName} para el ${when} no pudo ser confirmada.${reason ? ` Motivo: ${reason}.` : ''} Puedes buscar otro horario o restaurante en ${PWA_URL}.`;

    const res = await send({ to, subject: `Tu reserva en ${restaurantName} no pudo ser confirmada`, text, html });
    if (res.success) {
        await admin.from('reservations').update({ rejection_notified_at: now().toISOString(), rejection_notify_claimed_at: null }).eq('id', row.id);
        return { status: 'completed', sent: 1 };
    }

    await releaseClaim();
    const attemptNo: number = row.rejection_notify_attempts ?? 1;
    await logError(
        admin,
        `Aviso de rechazo de la reserva ${code} incompleto (intento ${attemptNo}/${MAX_NOTIFY_ATTEMPTS})${attemptNo >= MAX_NOTIFY_ATTEMPTS ? ': SE ABANDONA' : ''}: ${res.error ?? 'error desconocido'}`,
        { reservation_id: row.id, attempt: attemptNo, gave_up: attemptNo >= MAX_NOTIFY_ATTEMPTS },
    );
    return { status: 'failed', sent: 0 };
}

function buildRejectionEmailHtml(p: { restaurantName: string; firstName: string; when: string; reason: string | null; code: string }): string {
    const esc = escapeHtml;
    return `
<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 16px;background-color:#f1f5f9;color:#1a1a1a;">
    <div style="text-align:center;margin-bottom:20px;">
        <span style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:4px;color:#64748b;">Almuerzo.cl</span>
    </div>
    <table width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:24px;box-shadow:0 8px 40px rgba(0,0,0,0.12);">
        <tr><td style="padding:32px 28px;">
            <p style="margin:0 0 12px 0;font-size:15px;font-weight:700;color:#334155;">Hola${p.firstName ? ` ${esc(p.firstName)}` : ''}.</p>
            <p style="margin:0 0 16px 0;font-size:15px;color:#334155;line-height:1.6;">
                Tu solicitud de reserva en <strong>${esc(p.restaurantName)}</strong> para el <strong>${esc(p.when)}</strong>
                no pudo ser confirmada por el restaurante.
            </p>
            ${p.reason ? `<p style="margin:0 0 16px 0;font-size:14px;color:#64748b;line-height:1.6;">Motivo: ${esc(p.reason)}</p>` : ''}
            <p style="margin:0 0 20px 0;font-size:14px;color:#64748b;line-height:1.6;">Puedes buscar otro horario u otro restaurante cuando quieras.</p>
            <a href="${PWA_URL}" style="display:inline-block;background:#f97316;color:#ffffff;padding:14px 22px;text-decoration:none;border-radius:14px;font-weight:800;font-size:13px;">Buscar otra reserva</a>
            <p style="margin:24px 0 0 0;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;">Código ${esc(p.code)}</p>
        </td></tr>
    </table>
</div>`;
}
