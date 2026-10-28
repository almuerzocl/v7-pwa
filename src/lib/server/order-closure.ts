import { escapeHtml } from '@/lib/email-ticket-html';
import { sendEmail } from '@/lib/server/email';

/**
 * Cierre del día de los pedidos para llevar que quedaron abiertos (lo ejecuta /api/cron/close-day a las 03:00).
 *
 * Criterio de reputación (ver migración 020): solo se imputa al cliente lo que él debía ejecutar y no ejecutó, y desde que el
 * restaurante empezó a preparar el pedido:
 *   - PREPARANDO / LISTO sin retirar → NO_RETIRADO (penaliza).
 *   - PENDIENTE (el restaurante nunca respondió) → CANCELADO, sin penalizar.
 *   - APROBADA (el restaurante nunca empezó a prepararlo) → CANCELADO, sin penalizar; el trigger de inventario devuelve el stock.
 * Cada cierre deja marca en `timestamps` (actor `system` y motivo) y el cliente SIEMPRE recibe un aviso en la app y, si hay
 * correo, también por correo. Si el aviso falla, el cierre ya quedó aplicado.
 */

type ClosedStatus = 'CANCELADO' | 'NO_RETIRADO';
export interface ClosureRule {
    from: 'PENDIENTE' | 'APROBADA' | 'PREPARANDO' | 'LISTO';
    to: ClosedStatus;
    reason: string;
    /** Texto del aviso al cliente; `{code}` se reemplaza por el código del pedido. */
    message: string;
    subject: string;
}

export const CLOSURE_RULES: readonly ClosureRule[] = [
    {
        from: 'PENDIENTE', to: 'CANCELADO',
        reason: 'Vencido sin respuesta del restaurante',
        message: 'Tu pedido #{code} se canceló porque el restaurante no alcanzó a responderlo. No afecta tu reputación.',
        subject: 'Tu pedido se canceló',
    },
    {
        from: 'APROBADA', to: 'CANCELADO',
        reason: 'Cierre del día: el restaurante no llegó a preparar el pedido',
        message: 'Tu pedido #{code} se canceló porque el restaurante no alcanzó a prepararlo. No afecta tu reputación.',
        subject: 'Tu pedido se canceló',
    },
    {
        from: 'PREPARANDO', to: 'NO_RETIRADO',
        reason: 'Cierre del día: el pedido no se retiró',
        message: 'Tu pedido #{code} no fue retirado. Esto afecta tu reputación.',
        subject: 'Tu pedido no fue retirado',
    },
    {
        from: 'LISTO', to: 'NO_RETIRADO',
        reason: 'Cierre del día: el pedido no se retiró',
        message: 'Tu pedido #{code} no fue retirado. Esto afecta tu reputación.',
        subject: 'Tu pedido no fue retirado',
    },
];

// Cliente de Supabase mínimo (service role en el servidor).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = { from: (table: string) => any };

const BATCH = 500;

export interface ClosureSummary {
    cancelled: number;
    noRetirado: number;
    notified: number;
    emailed: number;
    conflicts: number;
}

/** Cierra los pedidos abiertos creados antes de `cutoff` (ISO, inicio del día de hoy en Santiago). Idempotente. */
export async function closeStaleOrders(admin: Admin, cutoff: string): Promise<ClosureSummary> {
    const summary: ClosureSummary = { cancelled: 0, noRetirado: 0, notified: 0, emailed: 0, conflicts: 0 };
    const restaurantNames = new Map<string, string>();

    for (const rule of CLOSURE_RULES) {
        const { data: rows, error } = await admin
            .from('takeaway_orders')
            .select('id, user_id, restaurant_id, unique_code, timestamps, metadata')
            .eq('status', rule.from)
            .lt('created_at', cutoff)
            .limit(BATCH);
        if (error) throw error;

        for (const row of (rows || []) as { id: string; user_id: string | null; restaurant_id: string; unique_code?: string | null; timestamps?: Record<string, unknown> | null; metadata?: Record<string, unknown> | null }[]) {
            const now = new Date().toISOString();
            const { data: updated, error: updError } = await admin
                .from('takeaway_orders')
                .update({
                    status: rule.to,
                    updated_at: now,
                    timestamps: { ...(row.timestamps || {}), [rule.to]: { at: now, actor_id: null, actor_role: 'system', reason: rule.reason } },
                })
                .eq('id', row.id)
                .eq('status', rule.from) // no pisa un cambio simultáneo (el cliente retiró, el local entregó)
                .select('id');
            if (updError) throw updError;
            if (!updated || updated.length === 0) { summary.conflicts++; continue; }
            if (rule.to === 'NO_RETIRADO') summary.noRetirado++; else summary.cancelled++;

            const code = row.unique_code || row.id.slice(0, 8).toUpperCase();
            const message = rule.message.replace('{code}', code);
            let restaurantName = restaurantNames.get(row.restaurant_id);
            if (restaurantName === undefined) {
                try {
                    const { data: rest } = await admin.from('restaurants').select('name').eq('id', row.restaurant_id).maybeSingle();
                    restaurantName = rest?.name || 'Tu pedido';
                } catch { restaurantName = 'Tu pedido'; }
                restaurantNames.set(row.restaurant_id, restaurantName as string);
            }

            if (row.user_id) {
                try {
                    const { error: nErr } = await admin.from('notifications').insert({
                        user_id: row.user_id,
                        restaurant_id: row.restaurant_id,
                        // NO_RETIRADO tiene tipo propio (la app lo muestra al instante); la cancelación sin culpa del cliente sigue el tipo de pedidos.
                        type: rule.to === 'NO_RETIRADO' ? 'NO_RETIRADO' : 'TAKEAWAY',
                        title: restaurantName,
                        message,
                        related_id: row.id,
                        priority: 'NORMAL',
                        actor_role: 'system',
                        is_read: false,
                    });
                    if (nErr) throw nErr;
                    summary.notified++;
                } catch (e) {
                    console.error('[close-day] No se pudo avisar en la app:', row.id, e);
                }
            }

            try {
                const { data: profile } = row.user_id
                    ? await admin.from('profiles').select('email, first_name').eq('id', row.user_id).maybeSingle()
                    : { data: null };
                const email = profile?.email || (row.metadata?.customer_email as string | undefined);
                if (email) {
                    const r = await sendEmail({
                        to: email,
                        subject: `${rule.subject} en ${restaurantName}`,
                        text: message,
                        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px"><h2>${escapeHtml(rule.subject)}</h2><p>${escapeHtml(message)}</p><p style="color:#64748b;font-size:13px">${escapeHtml(restaurantName as string)} · Almuerzo.cl</p></div>`,
                        rateLimitKey: row.user_id || undefined,
                    });
                    if (r?.success) summary.emailed++;
                }
            } catch (e) {
                console.error('[close-day] No se pudo enviar el correo:', row.id, e);
            }
        }
    }
    return summary;
}
