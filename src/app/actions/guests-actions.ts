"use server";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/utils/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

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

/**
 * Resuelve email/teléfono -> id de usuario existente. Reemplaza la llamada directa desde el
 * navegador a la RPC find_user_public_info (cuyo EXECUTE se revocó a anon/authenticated).
 * Requiere sesión, tiene rate limit por usuario y devuelve solo el id.
 * (El rate limit es en memoria por instancia de Cloud Run: acota abuso, no es global.)
 */
export async function matchExistingUserAction(email?: string, phone?: string): Promise<string | null> {
    if (!email && !phone) return null;

    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { allowed } = rateLimit(`match-user:${user.id}`, 30, 60_000);
    if (!allowed) return null;

    const { data, error } = await (supabaseAdmin() as any).rpc('find_user_public_info', {
        p_email: email || null,
        p_phone: phone || null,
    });
    if (error) {
        console.error('[matchExistingUser] RPC error:', error.message);
        return null;
    }
    const rows = data as { id: string }[] | null;
    return rows && rows.length > 0 ? rows[0].id : null;
}

/**
 * Devuelve cuáles de los números dados (los contactos del usuario) pertenecen a usuarios
 * registrados. Reemplaza el SELECT directo a profiles.phone/phone_number desde el navegador
 * (profiles ya no es legible por terceros). Solo devuelve los números coincidentes, nunca
 * otras columnas; requiere sesión, tope de números por llamada y rate limit por usuario.
 */
export async function findInterconnectedNumbersAction(numbers: string[]): Promise<string[]> {
    const clean = Array.from(new Set((numbers || []).filter((n) => typeof n === 'string' && n.length > 0 && n.length <= 32))).slice(0, 200);
    if (clean.length === 0) return [];

    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];

    const { allowed } = rateLimit(`interconnect:${user.id}`, 10, 60_000);
    if (!allowed) return [];

    const admin = supabaseAdmin() as any;
    const [byPhone, byPhoneNumber] = await Promise.all([
        admin.from('profiles').select('phone').in('phone', clean),
        admin.from('profiles').select('phone_number').in('phone_number', clean),
    ]);
    if (byPhone.error || byPhoneNumber.error) {
        console.error('[findInterconnectedNumbers] error:', (byPhone.error || byPhoneNumber.error).message);
        return [];
    }
    const wanted = new Set(clean);
    const found = new Set<string>();
    for (const r of byPhone.data ?? []) if (r.phone && wanted.has(r.phone)) found.add(r.phone);
    for (const r of byPhoneNumber.data ?? []) if (r.phone_number && wanted.has(r.phone_number)) found.add(r.phone_number);
    return Array.from(found);
}
