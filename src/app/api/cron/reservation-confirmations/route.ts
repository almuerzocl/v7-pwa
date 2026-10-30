import { NextResponse } from 'next/server';
import { processReservationConfirmations, processReservationRejections } from '@/lib/server/reservation-confirmation';
import { processGuestAdditionDeclines } from '@/lib/server/guest-addition-decline';
import { processOrderConfirmations } from '@/lib/server/order-confirmation';
import { processWelcomeEmails } from '@/lib/server/welcome-email-job';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Cloud Scheduler (cada minuto, job `pwa-reservation-confirmations`): envía los correos de las reservas CONFIRMADA y de
 * los pedidos APROBADA aún no avisados, el aviso de rechazo de reservas (solo al organizador), el aviso al organizador cuando el restaurante rechaza un aumento de personas y la bienvenida a comensales nuevos
 * (apagada salvo WELCOME_EMAILS_ENABLED=true). Protegida con
 * CRON_SECRET (mismo patrón que close-day). Cubre cualquier camino: autoaprobación, aprobación manual y operación del
 * restaurante. Cada proceso es independiente: si uno falla, los otros siguen.
 */
async function run<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
    try {
        return await fn();
    } catch (e: any) {
        return { error: e?.message ?? 'error' };
    }
}

export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get('authorization');
    if (!secret || secret.length < 16 || !authHeader || authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const reservations = await run(() => processReservationConfirmations());
    const rejections = await run(() => processReservationRejections());
    const declines = await run(() => processGuestAdditionDeclines());
    const orders = await run(() => processOrderConfirmations());
    const welcome = await run(() => processWelcomeEmails());
    const results = { reservations, rejections, declines, orders, welcome };

    const activity = Object.values(results).some((r) => 'claimed' in r && r.claimed > 0);
    const failed = Object.values(results).some((r) => 'error' in r);
    if (activity || failed) console.log('[CRON reservation-confirmations]', JSON.stringify(results));
    // `ok` solo si ningún proceso falló (así Cloud Scheduler no marca éxito con un proceso caído).
    return NextResponse.json({ ok: !failed, ...results }, { status: failed ? 500 : 200 });
}
