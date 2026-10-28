import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { TICKET_URL, TIMEZONE } from '@/lib/config';
import { buildTicketEmailHtml } from '@/lib/email-ticket-html';
import { hasOptions, parseOrderLines } from '@/lib/order-lines';
import { MAX_NOTIFY_ATTEMPTS, type ConfirmationDeps, type ConfirmationSummary } from '@/lib/server/reservation-confirmation';
import { sendEmail } from '@/lib/server/email';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';

/**
 * Correo "Pedido confirmado" de pedidos para llevar (migración 034). MISMA lógica que las reservas
 * (reservation-confirmation.ts): se envía UNA vez y solo con el pedido APROBADA (autoaprobado, aprobado a mano o
 * tomado por el propio restaurante). PENDIENTE no envía nada. El rechazo ya lo avisa el dashboard al cliente.
 * Reclamo atómico con claim_order_confirmations() (solo pedidos de las últimas 12 h), tope de 5 intentos.
 */

type Row = Record<string, any>;

function defaultDeps(): ConfirmationDeps {
    return {
        admin: getSupabaseAdmin(),
        send: (p) => sendEmail({ ...p, rateLimitKey: p.to }),
        now: () => new Date(),
    };
}

async function logError(admin: ConfirmationDeps['admin'], message: string, metadata: Row) {
    try {
        await admin.from('error_logs').insert({ app: 'pwa', source: 'order-confirmation', severity: 'error', message, metadata });
    } catch { /* no bloqueante */ }
}

function unitsOf(items: unknown): number {
    let list: unknown = items;
    if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch { list = []; }
    }
    if (!Array.isArray(list)) return 0;
    return list.reduce((acc: number, it: any) => acc + (Number(it?.quantity) || 1), 0);
}

export async function processOrderConfirmations(
    opts: { id?: string; limit?: number } = {},
    deps: ConfirmationDeps = defaultDeps(),
): Promise<ConfirmationSummary> {
    const { admin } = deps;
    const summary: ConfirmationSummary = { claimed: 0, completed: 0, emailsSent: 0, failed: 0, skipped: 0 };

    const { data: claimed, error: claimError } = await admin.rpc('claim_order_confirmations', {
        p_limit: opts.limit ?? 20,
        p_id: opts.id ?? null,
    });
    if (claimError) {
        await logError(admin, `No se pudo reclamar confirmaciones de pedidos: ${claimError.message}`, { id: opts.id ?? null });
        throw new Error(claimError.message);
    }

    for (const row of (claimed ?? []) as Row[]) {
        summary.claimed++;
        try {
            const r = await confirmOne(row, deps);
            summary.emailsSent += r.sent;
            if (r.status === 'completed') summary.completed++;
            else if (r.status === 'skipped') summary.skipped++;
            else summary.failed++;
        } catch (err: any) {
            summary.failed++;
            await admin.from('takeaway_orders').update({ confirmation_notify_claimed_at: null }).eq('id', row.id);
            await logError(admin, `Falló el aviso del pedido ${row.unique_code}: ${err?.message ?? err}`, {
                order_id: row.id,
                attempt: row.confirmation_notify_attempts,
            });
        }
    }
    return summary;
}

async function confirmOne(row: Row, deps: ConfirmationDeps): Promise<{ status: 'completed' | 'skipped' | 'failed'; sent: number }> {
    const { admin, send, now } = deps;
    const release = () => admin.from('takeaway_orders').update({ confirmation_notify_claimed_at: null }).eq('id', row.id);

    // El estado pudo cambiar entre el reclamo y el envío (p. ej. el cliente canceló).
    const { data: fresh } = await admin.from('takeaway_orders').select('status').eq('id', row.id).maybeSingle();
    if (!fresh || !['APROBADA', 'PREPARANDO'].includes(fresh.status)) {
        await release();
        return { status: 'skipped', sent: 0 };
    }

    const [{ data: restaurant }, { data: profile }] = await Promise.all([
        admin.from('restaurants').select('name').eq('id', row.restaurant_id).maybeSingle(),
        row.user_id
            ? admin.from('profiles').select('email, first_name').eq('id', row.user_id).maybeSingle()
            : Promise.resolve({ data: null }),
    ]);
    const metadata: Row = typeof row.metadata === 'string' ? safeParse(row.metadata) : (row.metadata ?? {});
    const to: string | null = ((metadata.customer_email as string | undefined) || profile?.email || null)?.trim() || null;
    if (!to) {
        // Sin correo no hay a quién avisar: se cierra para no reintentar.
        await admin.from('takeaway_orders').update({ confirmation_notified_at: now().toISOString(), confirmation_notify_claimed_at: null }).eq('id', row.id);
        return { status: 'skipped', sent: 0 };
    }

    const restaurantName: string = restaurant?.name || 'el restaurante';
    const name: string = profile?.first_name || row.customer_name || 'Cliente';
    const code = String(row.unique_code || row.id.split('-')[0]).toUpperCase();
    const ticketUrl = `${TICKET_URL}/o/${row.unique_code || row.id}`;
    const created = toZonedTime(new Date(row.created_at), TIMEZONE);
    const displayDate = format(created, 'eee d MMM', { locale: es });
    const displayTime: string = (metadata.pickup_time as string | undefined) || format(created, 'HH:mm');
    const itemCount = unitsOf(row.items);
    // El detalle (con opciones) solo se agrega al correo cuando algún plato las lleva: sin opciones el correo queda como siempre.
    const lines = parseOrderLines(row.items);
    const orderLines = hasOptions(lines) ? lines : undefined;

    const html = buildTicketEmailHtml({
        type: 'order', restaurantName, ticketCode: code, displayDate, displayTime, itemCount,
        totalAmount: Number(row.total_amount) || undefined, ticketUrl,
        recipientFirstName: name.split(' ')[0] || name, isPersonalInvite: false, orderLines,
    });
    const res = await send({
        to,
        subject: `Pedido confirmado en ${restaurantName}`,
        text: `Pedido confirmado en ${restaurantName}. Retiro: ${displayDate} ${displayTime}. Código: ${code}.`
            + (orderLines ? ` Detalle: ${orderLines.map((l) => `${l.quantity}x ${l.name}${l.options.length ? ` (${l.options.join(', ')})` : ''}`).join('; ')}.` : '')
            + ` Ver ticket: ${ticketUrl}`,
        html,
    });

    if (res.success) {
        await admin.from('takeaway_orders').update({ confirmation_notified_at: now().toISOString(), confirmation_notify_claimed_at: null }).eq('id', row.id);
        return { status: 'completed', sent: 1 };
    }

    await release();
    const attemptNo: number = row.confirmation_notify_attempts ?? 1;
    await logError(
        admin,
        `Aviso del pedido ${code} incompleto (intento ${attemptNo}/${MAX_NOTIFY_ATTEMPTS})${attemptNo >= MAX_NOTIFY_ATTEMPTS ? ': SE ABANDONA' : ''}: ${res.error ?? 'error desconocido'}`,
        { order_id: row.id, attempt: attemptNo, gave_up: attemptNo >= MAX_NOTIFY_ATTEMPTS },
    );
    return { status: 'failed', sent: 0 };
}

function safeParse(s: string): Row {
    try { return JSON.parse(s); } catch { return {}; }
}
