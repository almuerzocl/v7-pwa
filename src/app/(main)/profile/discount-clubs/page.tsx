"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { toggleInstitutionMembershipAction } from "@/app/actions/discount-actions";
import { ChevronLeft, Building2, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

interface DiscountInstitution {
    id: string;
    name: string;
    logo_url: string | null;
    rules: string | null;
    is_active: boolean;
}

export default function DiscountClubsPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [institutions, setInstitutions] = useState<DiscountInstitution[]>([]);
    const [membershipIds, setMembershipIds] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [togglingId, setTogglingId] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        if (!user?.id) return;
        try {
            const [instRes, memberRes] = await Promise.all([
                supabase
                    .from("discount_institutions")
                    .select("id, name, logo_url, rules, is_active")
                    .eq("is_active", true)
                    .order("name"),
                supabase
                    .from("user_institutions")
                    .select("institution_id")
                    .eq("user_id", user.id)
                    .eq("is_active", true),
            ]);

            if (instRes.error) throw instRes.error;
            if (memberRes.error) throw memberRes.error;

            setInstitutions(instRes.data ?? []);
            setMembershipIds(
                new Set((memberRes.data ?? []).map((m: { institution_id: string }) => m.institution_id))
            );
        } catch (err: unknown) {
            console.error(err);
            toast.error("Error al cargar instituciones");
        } finally {
            setLoading(false);
        }
    }, [user?.id]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleToggle = async (institutionId: string, currentlyMember: boolean) => {
        if (!user?.id || togglingId) return;
        setTogglingId(institutionId);

        try {
            const result = await toggleInstitutionMembershipAction(user.id, institutionId, !currentlyMember);
            if (!result.success) throw new Error(result.error);

            if (currentlyMember) {
                setMembershipIds((prev) => {
                    const next = new Set(prev);
                    next.delete(institutionId);
                    return next;
                });
                toast.success("Membresía removida");
            } else {
                setMembershipIds((prev) => new Set(prev).add(institutionId));
                toast.success("Membresía activada");
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Error al actualizar membresía";
            console.error("[discount-clubs] toggle error:", err);
            toast.error(msg);
        } finally {
            setTogglingId(null);
        }
    };

    return (
        <div className="w-full max-w-lg mx-auto p-4 space-y-6 pb-24">
            {/* Header */}
            <div className="flex items-center gap-3 pt-2">
                <button
                    onClick={() => router.back()}
                    className="p-2 rounded-2xl bg-card border border-border hover:border-primary/30 transition-colors"
                >
                    <ChevronLeft className="w-5 h-5" />
                </button>
                <h1 className="text-2xl font-black tracking-tight text-foreground">
                    Clubes de Descuento
                </h1>
            </div>

            {/* Loading */}
            {loading ? (
                <div className="flex justify-center py-20">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
            ) : institutions.length === 0 ? (
                <div className="text-center py-20 space-y-2">
                    <Building2 className="w-12 h-12 mx-auto text-muted-foreground/40" />
                    <p className="text-muted-foreground text-sm font-medium">
                        No hay instituciones disponibles
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {institutions.map((inst) => {
                        const isMember = membershipIds.has(inst.id);
                        const isToggling = togglingId === inst.id;

                        return (
                            <div
                                key={inst.id}
                                className="p-4 bg-card border border-border rounded-3xl flex items-center gap-4 transition-all"
                            >
                                {/* Logo or fallback */}
                                <div className="h-12 w-12 rounded-2xl bg-muted flex items-center justify-center overflow-hidden shrink-0">
                                    {inst.logo_url ? (
                                        <img
                                            src={inst.logo_url}
                                            alt={inst.name}
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <Building2 className="w-6 h-6 text-muted-foreground" />
                                    )}
                                </div>

                                {/* Info */}
                                <div className="flex-1 min-w-0">
                                    <p className="font-bold text-foreground truncate">{inst.name}</p>
                                    {inst.rules && (
                                        <p className="text-[11px] text-muted-foreground font-medium line-clamp-2">
                                            {inst.rules}
                                        </p>
                                    )}
                                </div>

                                {/* Toggle switch */}
                                <button
                                    disabled={isToggling}
                                    onClick={() => handleToggle(inst.id, isMember)}
                                    className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${
                                        isMember ? "bg-primary" : "bg-muted"
                                    } ${isToggling ? "opacity-50" : ""}`}
                                >
                                    <span
                                        className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                                            isMember ? "translate-x-5" : "translate-x-0"
                                        }`}
                                    />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
