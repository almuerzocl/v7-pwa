import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { refreshAllSnapshots } from '@/lib/olivia/snapshots';
import { santiagoNow } from '@/lib/olivia/rules';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Cloud Scheduler (diario, job `pwa-olivia-snapshots`, 10:30 Santiago, antes de la ventana de almuerzo de 11:00 a 14:00): reconstruye las
 * copias del día de OlivIA (oferta de comida, ficha física de los locales y pronóstico de Open-Meteo) y limpia lo viejo:
 * copias de más de 7 días y consultas de OlivIA de más de 90 días. Protegida con CRON_SECRET (mismo patrón que close-day).
 * Idempotente: se puede correr dos veces el mismo día.
 */
const SNAPSHOT_RETENTION_DAYS = 7;
const USAGE_RETENTION_DAYS = 90;

export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get('authorization');
    if (!secret || secret.length < 16 || !authHeader || authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    const snapshots = await refreshAllSnapshots(admin);

    const today = santiagoNow().date;
    const cut = (days: number) => new Date(Date.now() - days * 86400000);
    const purge = await Promise.all([
        admin.from('olivia_snapshots').delete({ count: 'exact' }).lt('day', santiagoNow(cut(SNAPSHOT_RETENTION_DAYS)).date),
        admin.from('olivia_usage').delete({ count: 'exact' }).lt('created_at', cut(USAGE_RETENTION_DAYS).toISOString()),
    ]);
    const purged = { snapshots: purge[0].error ? { error: purge[0].error.message } : purge[0].count ?? 0, usage: purge[1].error ? { error: purge[1].error.message } : purge[1].count ?? 0 };

    const failed = Object.entries(snapshots).filter(([, v]) => !v.ok);
    for (const [k, v] of failed) console.error(`[CRON olivia-snapshots] ${k} falló:`, v.error);
    console.log('[CRON olivia-snapshots]', JSON.stringify({ day: today, snapshots, purged }));
    const purgeFailed = Boolean(purge[0].error || purge[1].error);
    return NextResponse.json({ ok: failed.length === 0 && !purgeFailed, day: today, snapshots, purged }, { status: failed.length || purgeFailed ? 500 : 200 });
}
