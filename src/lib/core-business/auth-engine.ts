import { supabase } from "@/lib/supabase";
import { UserProfile, UserRole } from "@/types";
import { User } from "@supabase/supabase-js";

/**
 * AUTH BUSINESS ENGINE
 * Centralized logic for user authentication, profile management, and onboarding.
 * Following Almuerzo.cl Naming Convention Standards.
 */

/**
 * Fetches the user profile from the database.
 * @param p_user_id The unique identifier of the user.
 */
export async function fetchUserProfile(p_user_id: string): Promise<UserProfile | null> {
    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", p_user_id)
        .single();

    if (error) {
        if (error.code === "PGRST116") {
            console.log("AuthEngine: Profile not found for", p_user_id);
            return null;
        }
        // AbortError from auth lock contention (React Strict Mode) — don't crash
        if (error.message?.includes('AbortError') || error.name === 'AbortError') {
            console.warn("AuthEngine: Request aborted (lock contention), will retry on next auth event");
            return null;
        }
        console.error("AuthEngine: Error fetching profile", error);
        throw error;
    }

    return data as UserProfile;
}

/**
 * Ensures a user profile exists, creating a default one if it doesn't.
 * @param p_user The Supabase User object.
 */
export async function initializeUserProfile(p_user: User): Promise<UserProfile> {
    const v_userId = p_user.id;
    const v_email = p_user.email || "";
    const v_metadata = p_user.user_metadata || {};
    
    // Check if profile exists first
    const v_existingProfile = await fetchUserProfile(v_userId);
    if (v_existingProfile) return v_existingProfile;

    console.log("AuthEngine: Initializing new profile for", v_userId);

    const v_newProfile: Partial<UserProfile> = {
        id: v_userId,
        email: v_email,
        // Google OAuth sends given_name/family_name; email/password signup sends first_name/last_name
        first_name: v_metadata.given_name || v_metadata.first_name || v_metadata.full_name?.split(' ')[0] || "",
        last_name: v_metadata.family_name || v_metadata.last_name || v_metadata.full_name?.split(' ').slice(1).join(' ') || "",
        // Google OAuth sends avatar_url or picture
        photo_url: v_metadata.avatar_url || v_metadata.picture || undefined,
        role: "USER" as UserRole,
        account_type: "free",
        onboarding_completed: false,
        reservation_reputation: 100,
        takeaway_reputation: 100,
        total_reservations: 0,
        favorite_restaurant_ids: [],
        subscribed_daily_menu_ids: [],
        preferred_payment_methods: []
    };

    const { data, error } = await supabase
        .from("profiles")
        .upsert(v_newProfile, { onConflict: 'id', ignoreDuplicates: true })
        .select()
        .single();

    if (error) {
        // ignoreDuplicates: si otra pestaña/flujo creó el perfil en paralelo, no hay fila que devolver.
        const v_raced = await fetchUserProfile(v_userId);
        if (v_raced) return v_raced;
        console.error("AuthEngine: Failed to initialize profile", error);
        throw error;
    }

    return data as UserProfile;
}

/**
 * Validates if the user's profile is complete for core app usage.
 */
export function validateProfileCompleteness(p_profile: UserProfile | null): boolean {
    if (!p_profile) return false;
    return !!(p_profile.first_name && p_profile.last_name && p_profile.email);
}

/**
 * Checks if the user should be redirected to onboarding.
 */
export function shouldRedirectToOnboarding(p_profile: UserProfile | null): boolean {
    if (!p_profile) return false;
    return !p_profile.onboarding_completed;
}
