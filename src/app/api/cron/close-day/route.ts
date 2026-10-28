import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { noStoreFetch } from '@/lib/supabase/no-store-fetch';
import { startOfDay } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/config';
import { closeStaleOrders } from '@/lib/server/order-closure';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

type CloseTable = 'reservations' | 'takeaway_orders';

/**
 * Cierra por fila (conserva el historial de timestamps y deja el motivo) las operaciones que NO se
 * le imputan al cliente. Filtra por el estado de origen al escribir para no pisar un cambio concurrente.
 */
async function closeWithoutPenalty(
    table: CloseTable,
    dateColumn: 'date_time' | 'created_at',
    fromStatus: string,
    toStatus: string,
    reason: string,
    cutoff: string
): Promise<number> {
    const { data: rows, error } = await supabaseAdmin()
        .from(table)
        .select('id, timestamps')
        .eq('status', fromStatus)
        .lt(dateColumn, cutoff);
    if (error) throw error;

    const now = new Date().toISOString();
    let closed = 0;
    for (const row of (rows || []) as any[]) {
        const { error: updError } = await supabaseAdmin()
            .from(table)
            .update({
                status: toStatus,
                updated_at: now,
                timestamps: {
                    ...(row.timestamps || {}),
                    [toStatus]: { at: now, actor_role: 'system', reason },
                },
            })
            .eq('id', row.id)
            .eq('status', fromStatus);
        if (updError) throw updError;
        closed++;
    }
    return closed;
}

let _supabaseAdmin: SupabaseClient<any> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient<any>(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { global: { fetch: noStoreFetch } }
        );
    }
    return _supabaseAdmin;
}

/**
 * GET /api/cron/close-day
 * Cierre automático del día anterior.
 * Corre a las 00:30 AM hora Santiago (America/Santiago) via Cloud Scheduler.
 * Solo actúa sobre reservas y pedidos cuya fecha/hora es ANTERIOR al inicio del día de hoy.
 *
 * Criterio de reputación (ver migración 020): se imputa al cliente lo que él debía ejecutar y no ejecutó.
 *   - Reserva CONFIRMADA sin check-in            → NO_SHOW      (el cliente no llegó)
 *   - Pedido PREPARANDO / LISTO                  → NO_RETIRADO  (el cliente no retiró; el local ya lo había preparado)
 * y NO se imputa lo que depende del restaurante:
 *   - Reserva o pedido PENDIENTE (el restaurante nunca aprobó ni rechazó) → CANCELADA / CANCELADO,
 *     sin penalización, con registro del motivo en timestamps (actor_role 'system').
 *   - Pedido APROBADA (el restaurante nunca empezó a prepararlo) → CANCELADO sin penalizar; el stock se devuelve.
 *   Cada pedido cerrado avisa al cliente en la app y por correo (ver lib/server/order-closure).
 *   - Reserva con CHECK-IN CLIENTE (el cliente sí cumplió su parte; solo falta que el restaurante la
 *     marque) → COMPLETADA.
 */
export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get('authorization');
    if (!secret || secret.length < 16 || !authHeader || authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    try {
        // toZonedTime shifts the date so its UTC components reflect Santiago local time.
        // startOfDay on that gives us "Santiago midnight" in that shifted form.
        // fromZonedTime converts it back to real UTC — e.g. 2026-05-07T04:00:00Z for UTC-4.
        // Without fromZonedTime the cutoff would be 4 h early and miss late-evening reservations.
        const santiagoNow  = toZonedTime(new Date(), TIMEZONE);
        const todayStart   = fromZonedTime(startOfDay(santiagoNow), TIMEZONE).toISOString();

        console.log(`[CRON close-day] Cierre del día anterior. Corte: < ${todayStart}`);

        // 1. Reservas del día anterior
        //    a) PENDIENTE: el restaurante nunca respondió → CANCELADA, sin penalización.
        const resExpired = await closeWithoutPenalty(
            'reservations', 'date_time', 'PENDIENTE', 'CANCELADA',
            'Vencida sin respuesta del restaurante', todayStart
        );
        //    b) CHECK-IN CLIENTE: el cliente cumplió su parte → COMPLETADA.
        const resCheckedIn = await closeWithoutPenalty(
            'reservations', 'date_time', 'CHECK-IN CLIENTE', 'COMPLETADA',
            'Cierre del día: el cliente hizo check-in', todayStart
        );
        //    c) CONFIRMADA sin check-in: el cliente no llegó → NO_SHOW (penaliza).
        const { error: resError } = await supabaseAdmin()
            .from('reservations')
            .update({ status: 'NO_SHOW' })
            .eq('status', 'CONFIRMADA')
            .lt('date_time', todayStart);

        if (resError) {
            console.error('[CRON close-day] Error reservas:', resError);
            throw resError;
        }

        // 2. Pedidos abiertos de días anteriores: criterio, marca, actor y aviso al cliente en lib/server/order-closure.
        const orders = await closeStaleOrders(supabaseAdmin(), todayStart);

        console.log(`[CRON close-day] Cierre completado: reservas vencidas=${resExpired}, check-in→completada=${resCheckedIn}, pedidos: canceladas=${orders.cancelled}, no retirados=${orders.noRetirado}, avisos=${orders.notified}, correos=${orders.emailed}, conflictos=${orders.conflicts}.`);
        return NextResponse.json({ success: true, cutoff: todayStart, orders });

    } catch (err: any) {
        console.error('[CRON close-day] Falló:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
