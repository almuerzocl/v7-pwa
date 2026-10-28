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

const CANCELLABLE_STATUSES = ['CREADA', 'PENDIENTE', 'APROBADA', 'PREPARANDO', 'LISTO'];

export async function cancelTakeawayOrderAction(orderId: string, userId: string) {
    const auth = await verifyUser(userId);
    if (!auth.authorized) return { success: false, error: auth.error };

    try {
        // 1. Fetch order and verify ownership
        const { data: order, error: fetchError } = await supabaseAdmin()
            .from('takeaway_orders')
            .select('id, user_id, restaurant_id, status, unique_code, created_at, metadata, timestamps')
            .eq('id', orderId)
            .single();

        if (fetchError || !order) {
            return { success: false, error: 'Pedido no encontrado' };
        }

        if (order.user_id !== userId) {
            return { success: false, error: 'Solo el cliente puede cancelar este pedido' };
        }

        if (!CANCELLABLE_STATUSES.includes(order.status)) {
            return { success: false, error: `No se puede cancelar un pedido con estado "${order.status}"` };
        }

        // 2. Regla de reputación (única, ver migración 020): cancelar antes de que el restaurante
        // empiece a preparar (CREADA, PENDIENTE, APROBADA) no penaliza; cancelar con el pedido en
        // PREPARANDO o LISTO sí. No depende de average_prep_time ni de cuánto tiempo pasó.
        const now = new Date();
        const impactsReputation = ['PREPARANDO', 'LISTO'].includes(order.status);

        // 3. Determine new status
        const newStatus = impactsReputation ? 'NO_RETIRADO' : 'CANCELADO';
        const reason = impactsReputation
            ? 'Cancelado por el cliente con el pedido ya en preparación'
            : 'Cancelado por el cliente';

        // 4. Update order
        const metadata = typeof order.metadata === 'string' ? JSON.parse(order.metadata || '{}') : (order.metadata || {});
        const { error: updateError } = await supabaseAdmin()
            .from('takeaway_orders')
            .update({
                status: newStatus,
                updated_at: now.toISOString(),
                metadata: {
                    ...metadata,
                    cancellation_reason: reason,
                    cancelled_at: now.toISOString(),
                    cancelled_by: 'customer',
                    reputation_impact: impactsReputation
                },
                timestamps: {
                    ...(order as any).timestamps || {},
                    [newStatus]: {
                        at: now.toISOString(),
                        actor_role: 'customer',
                        actor_id: userId,
                        reason
                    }
                }
            })
            .eq('id', orderId);

        if (updateError) {
            console.error('[cancelTakeaway] Update error:', updateError);
            return { success: false, error: updateError.message };
        }

        console.log(`[cancelTakeaway] Order ${orderId} → ${newStatus} (reputation impact: ${impactsReputation})`);

        return {
            success: true,
            newStatus,
            impactsReputation
        };
    } catch (err: any) {
        console.error('[cancelTakeaway] Exception:', err);
        return { success: false, error: err.message };
    }
}
