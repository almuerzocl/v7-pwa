"use server";

// Estado de OlivIA para la portada: si está encendida y cuántas consultas le quedan hoy a esta persona. La sesión se valida con
// auth.getUser(); la lectura usa service_role en el servidor (las funciones de la migración 043 no tienen EXECUTE para anon/authenticated).
import { createClient as createSessionClient } from "@/utils/supabase/server";
import { getSupabaseAdmin } from "@/lib/server/supabase-admin";

export type OliviaStatus = {
    enabled: boolean;
    daily_limit: number;
    used: number;
    remaining: number;
    resets_at: string;
    budget_exhausted: boolean;
};

export async function getOliviaStatusAction(): Promise<{ status: OliviaStatus | null }> {
    try {
        const session = await createSessionClient();
        const { data: { user } } = await session.auth.getUser();
        if (!user) return { status: null };
        const { data, error } = await getSupabaseAdmin().rpc("olivia_usage", { p_user: user.id });
        if (error || !data) {
            if (error) console.error("[olivia-status] rpc error:", error.message);
            return { status: null };
        }
        return { status: data as OliviaStatus };
    } catch (e) {
        console.error("[olivia-status] error:", e);
        return { status: null };
    }
}
