"use server";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyUser } from "@/utils/supabase/auth-check";
import { createClient as createSessionClient } from "@/utils/supabase/server";

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

// Fire-and-forget: link user_id on manual orders matched by verified email
// so future user_id-based queries also find them.
async function backfillTakeawayUserId(orders: any[], userId: string) {
    const toBackfill = orders.filter((o) => !o.user_id);
    for (const order of toBackfill) {
        const { error } = await supabaseAdmin()
            .from('takeaway_orders')
            .update({ user_id: userId })
            .eq('id', order.id);
        if (error) {
            console.warn('[fetchUserOrders] Backfill user_id failed (non-fatal):', error.message);
        } else {
            console.log('[fetchUserOrders] Linked user_id on takeaway order', order.id);
        }
    }
}

export async function fetchUserOrdersAction(userId: string) {
    const auth = await verifyUser(userId);
    if (!auth.authorized) return { success: false, orders: [], error: auth.error };

    try {
        const selectStr = '*, restaurant:restaurants(name, address, id)';

        // Un pedido sin dueño (pedido manual del local) solo se asocia por el correo VERIFICADO de la cuenta de acceso.
        // Ni el teléfono ni el correo del perfil sirven: el usuario los edita, y vincular (user_id queda para siempre)
        // le daría el ticket completo de un pedido ajeno. Misma regla que "Mis reservas" (my-tickets-actions.ts).
        const session = await createSessionClient();
        const { data: { user: authUser } } = await session.auth.getUser();
        const verifiedEmail = authUser?.id === userId && authUser.email && authUser.email_confirmed_at
            ? authUser.email.toLowerCase()
            : null;

        const baseQuery = () =>
            supabaseAdmin()
                .from('takeaway_orders')
                .select(selectStr)
                .order('created_at', { ascending: false })
                .limit(150);

        // Dos consultas en paralelo:
        // 1. user_id (flujo normal y pedidos manuales ya vinculados)
        // 2. metadata->customer_email (pedidos manuales sin dueño), solo con correo verificado
        const queries = [
            baseQuery().eq('user_id', userId),
            ...(verifiedEmail
                ? [baseQuery().is('user_id', null).filter('metadata->>customer_email', 'eq', verifiedEmail)]
                : []),
        ];

        const results = await Promise.all(queries);

        // Merge and deduplicate by id
        const seen = new Set<string>();
        const allOrders: any[] = [];
        for (const res of results) {
            if (res.error) {
                console.warn('[fetchUserOrders] Partial error (non-fatal):', res.error.message);
                continue;
            }
            for (const row of res.data || []) {
                if (!seen.has(row.id)) {
                    seen.add(row.id);
                    allOrders.push(row);
                }
            }
        }

        allOrders.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        // Backfill user_id on matched-by-contact orders (fire-and-forget)
        backfillTakeawayUserId(allOrders, userId);

        return { success: true, orders: allOrders };
    } catch (err: any) {
        console.error('[fetchUserOrders] Exception:', err);
        return { success: false, orders: [], error: err.message };
    }
}
