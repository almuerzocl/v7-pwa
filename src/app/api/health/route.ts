import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { noStoreFetch } from '@/lib/supabase/no-store-fetch';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

let _supabase: SupabaseClient<any> | null = null;
function supabase() {
    if (!_supabase) {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) return null;
        _supabase = createClient<any>(url, key, { global: { fetch: noStoreFetch } });
    }
    return _supabase;
}

export async function GET() {
    const checks: Record<string, string> = { app: 'ok' };

    try {
        const client = supabase();
        if (!client) {
            checks.db = 'unreachable';
        } else {
            const { error } = await client.from('restaurants').select('id').limit(1);
            checks.db = error ? 'error' : 'ok';
        }
    } catch {
        checks.db = 'unreachable';
    }

    const status = Object.values(checks).every(v => v === 'ok') ? 'ok' : 'degraded';
    const httpStatus = status === 'ok' ? 200 : 503;

    return NextResponse.json({ status, checks, timestamp: new Date().toISOString() }, { status: httpStatus });
}
