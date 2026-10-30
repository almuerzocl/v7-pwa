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

export async function toggleFavoriteAction(
    userId: string,
    restaurantId: string,
    currentFavoriteIds: string[]
): Promise<{ success: boolean; newFavoriteIds?: string[]; error?: string }> {
    const auth = await verifyUser(userId);
    if (!auth.authorized) return { success: false, error: auth.error };

    const isFavorite = currentFavoriteIds.includes(restaurantId);
    const newFavoriteIds = isFavorite
        ? currentFavoriteIds.filter(id => id !== restaurantId)
        : [...currentFavoriteIds, restaurantId];

    const { error } = await supabaseAdmin()
        .from("profiles")
        .update({ favorite_restaurant_ids: newFavoriteIds })
        .eq("id", userId);

    if (error) return { success: false, error: error.message };
    return { success: true, newFavoriteIds };
}

export async function toggleSubscriptionAction(
    userId: string,
    restaurantId: string,
    currentSubscribedIds: string[]
): Promise<{ success: boolean; newSubscribedIds?: string[]; error?: string }> {
    const auth = await verifyUser(userId);
    if (!auth.authorized) return { success: false, error: auth.error };

    const isSubscribed = currentSubscribedIds.includes(restaurantId);
    const newSubscribedIds = isSubscribed
        ? currentSubscribedIds.filter(id => id !== restaurantId)
        : [...currentSubscribedIds, restaurantId];

    const { error } = await supabaseAdmin()
        .from("profiles")
        .update({ subscribed_daily_menu_ids: newSubscribedIds })
        .eq("id", userId);

    if (error) return { success: false, error: error.message };
    return { success: true, newSubscribedIds };
}
