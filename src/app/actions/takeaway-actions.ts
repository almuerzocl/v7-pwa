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

// Fire-and-forget: link user_id on manual orders matched by email/phone
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

        // Fetch user's email and phone so we can match manual orders that predate account linking
        const { data: profile } = await supabaseAdmin()
            .from('profiles')
            .select('email, phone_number')
            .eq('id', userId)
            .maybeSingle();

        const userEmail = profile?.email ?? null;
        const userPhone = profile?.phone_number ?? null;

        const baseQuery = () =>
            supabaseAdmin()
                .from('takeaway_orders')
                .select(selectStr)
                .order('created_at', { ascending: false })
                .limit(150);

        // Three parallel queries mirroring the reservations page pattern:
        // 1. user_id match (normal flow + manual orders already linked)
        // 2. customer_phone match (manual orders, unlinked)
        // 3. metadata->customer_email match (manual orders, unlinked)
        const queries = [
            baseQuery().eq('user_id', userId),
            ...(userPhone
                ? [baseQuery().is('user_id', null).eq('customer_phone', userPhone)]
                : []),
            ...(userEmail
                ? [baseQuery().is('user_id', null).filter('metadata->>customer_email', 'eq', userEmail)]
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
