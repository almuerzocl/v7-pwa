import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { PWA_URL, TIMEZONE } from '@/lib/config';
import { escapeHtml } from '@/lib/email-ticket-html';
import { sendEmail } from '@/lib/server/email';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';

/**
 * Aviso por correo al organizador cuando el restaurante RECHAZA el aumento de personas de una reserva confirmada
 * (migración 050; el trigger de la 049 ya devolvió la reserva a su tamaño anterior y a CONFIRMADA). Una sola vez,
 * solo al organizador, solo si la reserva sigue CONFIRMADA y su hora no pasó. Mismo patrón que los demás emisores:
 * reclamo atómico en la base (`claim_guest_addition_declines`, tope de 5 intentos) y marca de enviado.
 */
type Row = Record<string, any>;

export interface DeclineDeps {
    admin: ReturnType<typeof getSupabaseAdmin>;
    send: (p: { to: string; subject: string; text: string; html: string }) => Promise<{ success: boolean; error?: string }>;
}
export interface DeclineSummary { claimed: number; completed: number; emailsSent: number; failed: number; skipped: number }

function defaultDeps(): DeclineDeps {
    return { admin: getSupabaseAdmin(), send: (p) => sendEmail({ ...p, rateLimitKey: p.to }) };
}

export function buildDeclineNotice(p: { firstName: string; restaurantName: string; when: string; declined: number; previous: number; removed: string[] }) {
    const esc = escapeHtml;
    const names = p.removed.filter(Boolean);
    const removedTxt = names.length ? ` Los invitados que agregaste (${names.join(', ')}) no quedaron en la reserva y no recibieron ninguna invitación.` : '';
    const subject = `${p.restaurantName} no pudo aceptar el aumento de tu reserva`;
    const text = `Hola${p.firstName ? ` ${p.firstName}` : ''}. ${p.restaurantName} no pudo aceptar el aumento de tu reserva a ${p.declined} personas. ` +
        `Tu reserva se mantiene confirmada para ${p.previous} personas el ${p.when}.${removedTxt} ` +
        `Si quieres, puedes agregar menos invitados o buscar otro horario o restaurante en ${PWA_URL}.`;
    const html = `
<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 16px;background-color:#f1f5f9;color:#1a1a1a;">
    <div style="text-align:center;margin-bottom:20px;"><span style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:4px;color:#64748b;">Almuerzo.cl</span></div>
    <table width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:24px;box-shadow:0 8px 40px rgba(0,0,0,0.12);"><tr><td style="padding:32px 28px;">
        <p style="margin:0 0 12px 0;font-size:15px;font-weight:700;color:#334155;">Hola${p.firstName ? ` ${esc(p.firstName)}` : ''}.</p>
        <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#334155;"><strong>${esc(p.restaurantName)}</strong> no pudo aceptar el aumento de tu reserva a <strong>${p.declined}</strong> personas.</p>
        <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#334155;">Tu reserva <strong>se mantiene confirmada para ${p.previous} personas</strong> el <strong>${esc(p.when)}</strong>.</p>
        ${names.length ? `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;color:#475569;">Los invitados que agregaste (${names.map(esc).join(', ')}) no quedaron en la reserva y no recibieron ninguna invitación.</p>` : ''}
        <p style="margin:0;font-size:14px;line-height:1.5;color:#475569;">Si quieres, puedes agregar menos invitados o buscar otro horario o restaurante en <a href="${esc(PWA_URL)}" style="color:#ea580c;">${esc(PWA_URL.replace(/^https?:\/\//, ''))}</a>.</p>
    </td></tr></table>
</div>`;
    return { subject, text, html };
}

export async function processGuestAdditionDeclines(opts: { id?: string; limit?: number } = {}, deps: DeclineDeps = defaultDeps()): Promise<DeclineSummary> {
    const { admin, send } = deps;
    const summary: DeclineSummary = { claimed: 0, completed: 0, emailsSent: 0, failed: 0, skipped: 0 };
    const { data: claimed, error } = await admin.rpc('claim_guest_addition_declines', { p_limit: opts.limit ?? 20, p_id: opts.id ?? null });
    if (error) throw new Error(error.message);

    for (const row of (claimed ?? []) as Row[]) {
        summary.claimed++;
        try {
            const decl = row.metadata?.guest_addition_declined ?? {};
            const [{ data: restaurant }, { data: profile }] = await Promise.all([
                admin.from('restaurants').select('name').eq('id', row.restaurant_id).maybeSingle(),
                row.organizer_id ? admin.from('profiles').select('email, first_name').eq('id', row.organizer_id).maybeSingle() : Promise.resolve({ data: null }),
            ]);
            const to = ((profile as Row | null)?.email as string | undefined)?.trim();
            if (!to) {
                await admin.rpc('mark_guest_addition_decline_notified', { p_id: row.id }); // sin correo no hay a quién avisar: se cierra
                summary.skipped++;
                continue;
            }
            const n = buildDeclineNotice({
                firstName: ((profile as Row | null)?.first_name as string) || '',
                restaurantName: (restaurant as Row | null)?.name || 'El restaurante',
                when: format(toZonedTime(new Date(row.date_time), TIMEZONE), "EEEE d 'de' MMMM 'a las' HH:mm", { locale: es }),
                declined: Number(decl.declined_party_size) || row.party_size,
                previous: Number(decl.previous_party_size) || row.party_size,
                removed: Array.isArray(decl.removed_guests) ? decl.removed_guests.map(String) : [],
            });
            const res = await send({ to, ...n });
            if (res.success) {
                await admin.rpc('mark_guest_addition_decline_notified', { p_id: row.id });
                summary.completed++;
                summary.emailsSent++;
            } else {
                summary.failed++; // el reclamo vence a los 5 min y se reintenta (tope 5)
                console.error(`[guest-addition-decline] envío falló (${row.unique_code}): ${res.error}`);
            }
        } catch (e: any) {
            summary.failed++;
            console.error(`[guest-addition-decline] ${row.unique_code}: ${e?.message ?? e}`);
        }
    }
    return summary;
}
