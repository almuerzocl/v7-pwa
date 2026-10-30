"use client";

import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { getInitials } from "@/lib/core-business/ui-helpers";
import { LocationSelector } from "./LocationSelector";
import { NotificationsBell } from "./NotificationsBell";

export function TopHeader() {
    const { user, profile } = useAuth();
    const initials = getInitials(profile?.first_name || user?.email?.split("@")[0], profile?.last_name);

    return (
        <header className="sticky top-0 z-[10000] w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
            <div className="flex h-16 items-center gap-3 px-4 md:px-6 w-full max-w-7xl mx-auto">
                <div className="flex-1 min-w-0">
                    <LocationSelector />
                </div>
                {user && <NotificationsBell />}
                {user && (
                    <Link
                        href="/profile"
                        aria-label="Mi cuenta"
                        className="h-10 w-10 shrink-0 rounded-full bg-primary/10 border-2 border-background ring-2 ring-primary/20 flex items-center justify-center overflow-hidden"
                    >
                        {profile?.photo_url ? (
                            <img src={profile.photo_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                            <span className="text-sm font-black text-primary">{initials}</span>
                        )}
                    </Link>
                )}
            </div>
        </header>
    );
}
