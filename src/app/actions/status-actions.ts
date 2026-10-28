"use server";

import { createClient } from "@supabase/supabase-js";
import { verifyUser } from "@/utils/supabase/auth-check";

let _supabaseAdmin: ReturnType<typeof createClient> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
    }
    return _supabaseAdmin;
}

const TRANSITION_TABLES = ['reservations', 'takeaway_orders'] as const;

/**
 * El rol del actor se deriva acá, desde la BD, y NO se acepta del cliente: transition_status
 * corre con service_role y confía en p_actor_role, así que un actorRole enviado por el navegador
 * permitiría a cualquier usuario logueado actuar como 'restaurant'.
 */
export async function transitionStatusAction(
    table: string,
    id: string,
    newStatus: string,
    actorId: string,
    reason?: string
) {
    const auth = await verifyUser(actorId);
    if (!auth.authorized) return { success: false, error: auth.error };

    if (!(TRANSITION_TABLES as readonly string[]).includes(table)) {
        return { success: false, error: 'Tabla inválida' };
    }

    const customerColumn = table === 'reservations' ? 'organizer_id' : 'user_id';
    const { data: record } = await supabaseAdmin()
        .from(table)
        .select(`restaurant_id, ${customerColumn}`)
        .eq('id', id)
        .maybeSingle();
    if (!record) return { success: false, error: 'Registro no encontrado' };

    const row = record as any;
    const [{ data: profile }, { data: restaurant }] = await Promise.all([
        supabaseAdmin().from('profiles').select('restaurant_id').eq('id', actorId).maybeSingle(),
        supabaseAdmin().from('restaurants').select('owner_id').eq('id', row.restaurant_id).maybeSingle(),
    ]);
    const isStaff = (profile as any)?.restaurant_id === row.restaurant_id
        || (restaurant as any)?.owner_id === actorId;
    const isCustomer = row[customerColumn] === actorId;
    const actorRole = isCustomer ? 'customer' : isStaff ? 'restaurant' : null;
    if (!actorRole) return { success: false, error: 'No tienes permiso para realizar esta acción.' };

    try {
        const { data, error } = await supabaseAdmin().rpc('transition_status', {
            p_table: table,
            p_id: id,
            p_new_status: newStatus,
            p_actor_id: actorId,
            p_actor_role: actorRole,
            p_reason: reason || null,
        });

        if (error) {
            console.error(`[transitionStatus] RPC error:`, error);
            return { success: false, error: error.message };
        }

        const result = data as any;
        if (result && result.success === false) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            previousStatus: result?.previous_status,
            newStatus: result?.new_status,
            notifyTarget: result?.notify_target,
            priority: result?.priority,
        };
    } catch (err: any) {
        console.error(`[transitionStatus] Exception:`, err);
        return { success: false, error: err.message };
    }
}
