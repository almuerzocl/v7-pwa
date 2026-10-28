"use server";

// Uso de operaciones del cliente (hoy y esta semana) para mostrarlo en la PWA. La sesión se valida con auth.getUser() y la
// lectura usa service_role en el servidor (operation_usage no tiene EXECUTE para anon/authenticated). La regla y los
// límites viven en la base (migración 040); esto solo los lee.
import { createClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/utils/supabase/server";
import type { OperationUsage } from "@/lib/operation-limits";

export async function getOperationUsageAction(): Promise<{ usage: OperationUsage | null }> {
    try {
        const session = await createSessionClient();
        const { data: { user } } = await session.auth.getUser();
        if (!user) return { usage: null };

        const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data, error } = await admin.rpc("operation_usage", { p_user: user.id });
        if (error || !data) {
            if (error) console.error("[operation-usage] rpc error:", error.message);
            return { usage: null };
        }
        return { usage: data as OperationUsage };
    } catch (e) {
        console.error("[operation-usage] error:", e);
        return { usage: null };
    }
}
