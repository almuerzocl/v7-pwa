import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { noStoreFetch } from '@/lib/supabase/no-store-fetch';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

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
 * GET /api/tasks/calculate-reputation
 * Disparado por Cloud Scheduler (job `pwa-calculate-reputation`, 03:30 America/Santiago, DESPUÉS de
 * `pwa-close-day` de las 03:00, que es quien marca NO_SHOW / NO_RETIRADO del día anterior).
 *
 * Esta ruta NO calcula nada: solo ejecuta la función de la base de datos `calculate_daily_reputation()`
 * (migración 020), que es la ÚNICA fuente de verdad de la fórmula:
 *   reputación = ROUND(100 × cumplidas / (cumplidas + incumplidas)) sobre los últimos 30 días calendario
 *   (hora de Chile, sin contar hoy), igual para reservas y pedidos; 100 si no hay operaciones resueltas.
 * Escribe profiles.reservation_reputation y profiles.takeaway_reputation (0..100) y es idempotente.
 */
export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get('authorization');
    if (!secret || secret.length < 16 || !authHeader || authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    try {
        const { error } = await supabaseAdmin().rpc('calculate_daily_reputation');
        if (error) {
            console.error('[CRON calculate-reputation] Error en calculate_daily_reputation:', error);
            return NextResponse.json({ success: false, error: error.message }, { status: 500 });
        }
        console.log('[CRON calculate-reputation] Reputación diaria recalculada.');
        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('[CRON calculate-reputation] Falló:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
