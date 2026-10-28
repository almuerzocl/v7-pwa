"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { fetchUserProfile, initializeUserProfile } from "@/lib/core-business/auth-engine";
import { UserProfile } from "@/types";

interface AuthContextType {
    user: User | null;
    profile: UserProfile | null;
    session: Session | null;
    isLoading: boolean;
    signOut: () => Promise<void>;
    refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
    user: null,
    profile: null,
    session: null,
    isLoading: true,
    signOut: async () => { },
    refreshProfile: async () => { },
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
    const [user, setUser] = useState<User | null>(null);
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [session, setSession] = useState<Session | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const refreshProfile = async () => {
        if (user) {
            await fetchProfile(user.id);
        }
    };

    useEffect(() => {
        let v_mounted = true;

        // Use onAuthStateChange as the single source of truth.
        // Calling getSession() separately races with onAuthStateChange and causes
        // "Lock broken by another request with the 'steal' option" AbortErrors
        // in React Strict Mode (double-mount).
        const { data: authListener } = supabase.auth.onAuthStateChange(
            async (event, newSession) => {
                if (!v_mounted) return;

                // Ignore transient TOKEN_REFRESHED events that briefly emit null session
                if (event === 'TOKEN_REFRESHED' && !newSession) return;

                // On explicit sign out, clear state and redirect
                if (event === 'SIGNED_OUT') {
                    setSession(null);
                    setUser(null);
                    setProfile(null);
                    setIsLoading(false);
                    return;
                }

                setSession(newSession);
                setUser(newSession?.user ?? null);

                if (newSession?.user) {
                    // Unblock pages immediately — user identity is confirmed.
                    // Profile loads in the background; components that need it
                    // will re-render once it arrives.
                    setIsLoading(false);
                    fetchProfile(newSession.user.id, v_mounted);
                } else {
                    setProfile(null);
                    setIsLoading(false);
                }
            }
        );

        return () => {
            v_mounted = false;
            authListener.subscription.unsubscribe();
        };
    }, []);

    const fetchProfile = async (userId: string, p_mounted: boolean = true) => {
        const safetyTimeout = setTimeout(() => {
            if (p_mounted) setIsLoading(false);
        }, 3000);

        try {
            const v_profile = await fetchUserProfile(userId);

            if (p_mounted) {
                if (v_profile) {
                    setProfile(v_profile);
                } else {
                    const { data: { user: v_currUser } } = await supabase.auth.getUser();
                    if (v_currUser) {
                        const v_newProfile = await initializeUserProfile(v_currUser);
                        setProfile(v_newProfile);
                    }
                }
            }
        } catch (error) {
            console.error("AuthContext: Error in profile lifecycle", error);
        } finally {
            clearTimeout(safetyTimeout);
            if (p_mounted) setIsLoading(false);
        }
    };

    const signOut = async () => {
        // Delegate entirely to server-side route: clears cookies then redirects to /login
        window.location.href = "/auth/signout";
    };

    return (
        <AuthContext.Provider value={{ user, profile, session, isLoading, signOut, refreshProfile }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
};
