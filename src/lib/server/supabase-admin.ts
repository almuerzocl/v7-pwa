import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { noStoreFetch } from '@/lib/supabase/no-store-fetch';

let admin: SupabaseClient<any> | null = null;

/** Cliente service_role del servidor (bypassea RLS: usar solo tras validar la sesión). Sin caché de Next. */
export function getSupabaseAdmin(): SupabaseClient<any> {
    if (!admin) {
        admin = createClient<any>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: noStoreFetch },
        });
    }
    return admin;
}
