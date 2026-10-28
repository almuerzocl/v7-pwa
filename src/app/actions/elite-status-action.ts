"use server";

// Estado ELITE de la cuenta para la pantalla de suscripciones. La sesión se valida con auth.getUser() y la lectura usa service_role
// en el servidor (elite_periods y shopify_orders no tienen permisos para anon/authenticated). Solo lee: quien escribe es el admin-dashboard.
import { createClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/utils/supabase/server";
import { eliteStatusFrom, type EliteStatus } from "@/lib/elite";

export async function getEliteStatusAction(): Promise<{ status: EliteStatus | null }> {
    try {
        const session = await createSessionClient();
        const { data: { user } } = await session.auth.getUser();
        if (!user) return { status: null };

        const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: periods, error } = await admin.from("elite_periods").select("starts_at, ends_at, status").eq("user_id", user.id);
        if (error) {
            console.error("[elite-status] periods error:", error.message);
            return { status: null };
        }

        // Compra pagada con el correo de la cuenta que espera ser procesada (pedido pendiente marcado por el admin como «elite:»).
        let pendingOrders = 0;
        const email = (user.email ?? "").trim().toLowerCase();
        if (email) {
            const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
            const { data: orders } = await admin.from("shopify_orders").select("email").eq("process_status", "pendiente").like("process_error", "elite:%").ilike("email", pattern);
            pendingOrders = (orders ?? []).filter((o: { email: string | null }) => (o.email ?? "").trim().toLowerCase() === email).length;
        }
        return { status: eliteStatusFrom(periods ?? [], pendingOrders) };
    } catch (e) {
        console.error("[elite-status] error:", e);
        return { status: null };
    }
}
