import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Cloud Scheduler (diario, job `pwa-analytics-rollup`, 04:30 Santiago): resume por día y borra el detalle de más de 30 días
 * (retención) de DOS fuentes, cada una por su cuenta (una falla no frena a la otra), y borra los registros de correos enviados
 * de más de 12 meses (`error_logs`, source `email-sent`):
 *  - eventos de cliente por local  -> restaurant_daily_summary   (rollup_client_events)
 *  - eventos de plataforma         -> platform_daily_summary     (rollup_platform_events)
 * Protegida con CRON_SECRET (mismo patrón que close-day). Las funciones SQL son idempotentes: se pueden correr dos veces el mismo día.
 */
// Retención declarada en /privacidad: el registro de correos enviados (con el correo del destinatario) se guarda 12 meses.
const EMAIL_LOG_RETENTION_MONTHS = 12;

async function purgeSentEmailLog(admin: ReturnType<typeof getSupabaseAdmin>) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - EMAIL_LOG_RETENTION_MONTHS);
    const { count, error } = await admin
        .from('error_logs')
        .delete({ count: 'exact' })
        .eq('app', 'pwa')
        .eq('source', 'email-sent')
        .lt('created_at', cutoff.toISOString());
    return { data: { rows_purged: count ?? 0 }, error };
}

export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get('authorization');
    if (!secret || secret.length < 16 || !authHeader || authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    const runs = await Promise.all([
        admin.rpc('rollup_client_events').then(r => ({ name: 'client_events', ...r })),
        admin.rpc('rollup_platform_events').then(r => ({ name: 'platform_events', ...r })),
        purgeSentEmailLog(admin).then(r => ({ name: 'email_log', ...r })),
    ]);

    const failed = runs.filter(r => r.error);
    for (const r of runs) {
        if (r.error) console.error(`[CRON analytics-rollup] ${r.name} falló:`, r.error.message);
        else console.log(`[CRON analytics-rollup] ${r.name}`, JSON.stringify(r.data));
    }

    const body = {
        ok: failed.length === 0,
        ...Object.fromEntries(runs.map(r => [r.name, r.error ? { error: r.error.message } : r.data])),
        // Compatibilidad con el formato anterior (solo los eventos de cliente).
        ...(runs[0].error ? {} : (runs[0].data as object)),
    };
    return NextResponse.json(body, { status: failed.length ? 500 : 200 });
}
