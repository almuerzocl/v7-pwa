"use server";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyUser } from "@/utils/supabase/auth-check";

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

export async function toggleInstitutionMembershipAction(
    userId: string,
    institutionId: string,
    join: boolean
): Promise<{ success: boolean; error?: string }> {
    try {
        const auth = await verifyUser(userId);
        if (!auth.authorized) {
            console.error("[discount] verifyUser failed:", auth.error);
            return { success: false, error: auth.error };
        }

        if (join) {
            const { error } = await supabaseAdmin()
                .from("user_institutions")
                .upsert(
                    { user_id: userId, institution_id: institutionId, is_active: true },
                    { onConflict: "user_id,institution_id" }
                );
            if (error) {
                console.error("[discount] upsert error:", error);
                return { success: false, error: error.message };
            }
        } else {
            const { error } = await supabaseAdmin()
                .from("user_institutions")
                .delete()
                .eq("user_id", userId)
                .eq("institution_id", institutionId);
            if (error) {
                console.error("[discount] delete error:", error);
                return { success: false, error: error.message };
            }
        }

        return { success: true };
    } catch (err: any) {
        console.error("[discount] unexpected error:", err);
        return { success: false, error: err?.message ?? "Error inesperado" };
    }
}
