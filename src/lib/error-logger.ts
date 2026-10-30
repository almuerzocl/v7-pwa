import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _supabaseAdmin: SupabaseClient<any> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
    }
    return _supabaseAdmin;
}

const APP_NAME = 'pwa';

interface LogEntry {
    source: string;
    message: string;
    severity?: 'error' | 'warn' | 'info';
    metadata?: Record<string, any>;
    userId?: string;
}

export async function logError({ source, message, severity = 'error', metadata = {}, userId }: LogEntry) {
    try {
        await supabaseAdmin().from('error_logs').insert({
            app: APP_NAME,
            source,
            severity,
            message: message.slice(0, 2000),
            metadata,
            user_id: userId || null,
        });
    } catch {
        // Fallback to console if DB logging fails
        console.error(`[${APP_NAME}:${source}]`, message);
    }
}
