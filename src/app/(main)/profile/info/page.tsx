"use client";

import { changePassword } from "@/lib/change-password";
import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
    ArrowLeft, Camera, Mail, Phone, MapPin, Edit3,
    Key, ShieldCheck, CheckCircle2, AlertCircle, LogOut,
    Smartphone, MessageSquare, Building2, Loader2,
} from "lucide-react";
import dynamic from "next/dynamic";
import { toggleInstitutionMembershipAction } from "@/app/actions/discount-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PhoneInput, { formatChileanPhone } from "@/components/ui/PhoneInput";
import { getInitials } from "@/lib/core-business/ui-helpers";
import { stripRegionAndCountry } from "@/lib/address-format";
import { useRouter, usePathname } from "next/navigation";

const AddressAutocomplete = dynamic(
    () => import("@/components/ui/AddressAutocomplete").then(m => ({ default: m.AddressAutocomplete })),
    { ssr: false }
);
import toast from "react-hot-toast";

// ─── Types ────────────────────────────────────────────────────────────────────
interface DiscountInstitution {
    id: string;
    name: string;
    logo_url: string | null;
    rules: string | null;
    is_active: boolean;
}

// ─── Section heading ──────────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
    return (
        <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 px-1 pt-6 pb-1">
            {children}
        </h2>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function MiCuentaInfoPage() {
    const { user, profile, signOut, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!authLoading && !user) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        }
    }, [user, authLoading, router, pathname]);

    // ── Mi Información state
    const [infoLoading, setInfoLoading] = useState(false);
    const [formData, setFormData] = useState({
        first_name: "",
        last_name: "",
        display_name: "",
        phone: "",
        default_address: "",
        default_address_lat: null as number | null,
        default_address_lng: null as number | null,
    });

    useEffect(() => {
        if (profile) {
            setFormData({
                first_name:           profile.first_name || "",
                last_name:            profile.last_name || "",
                display_name:         profile.display_name || "",
                phone:                profile.phone || profile.phone_number || "",
                default_address:      profile.default_address ? stripRegionAndCountry(profile.default_address) : "",
                default_address_lat:  profile.default_address_lat || null,
                default_address_lng:  profile.default_address_lng || null,
            });
        }
    }, [profile]);

    const handleSaveInfo = async () => {
        if (!user) return;
        setInfoLoading(true);
        try {
            const { error } = await supabase
                .from("profiles")
                .update({
                    first_name:          formData.first_name,
                    last_name:           formData.last_name,
                    display_name:        formData.display_name,
                    phone:               formData.phone,
                    phone_number:        formData.phone,
                    default_address:     formData.default_address,
                    default_address_lat: formData.default_address_lat,
                    default_address_lng: formData.default_address_lng,
                })
                .eq("id", user.id);
            if (error) throw error;
            toast.success("Información actualizada");
            router.refresh();
        } catch {
            toast.error("Error al actualizar");
        } finally {
            setInfoLoading(false);
        }
    };

    // ── Seguridad state
    const [secLoading, setSecLoading] = useState(false);
    const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });

    const handleUpdatePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (passwords.new !== passwords.confirm) { toast.error("Las contraseñas no coinciden"); return; }
        setSecLoading(true);
        const result = await changePassword({ newPassword: passwords.new, currentPassword: passwords.current });
        setSecLoading(false);
        if (!result.ok) { toast.error(result.error); return; }
        toast.success("Contraseña actualizada");
        setPasswords({ current: "", new: "", confirm: "" });
    };

    const handleSignOut = async () => {
        await signOut();
        router.push("/login");
    };

    // ── Clubes de Descuentos state
    const [institutions,  setInstitutions]  = useState<DiscountInstitution[]>([]);
    const [membershipIds, setMembershipIds] = useState<Set<string>>(new Set());
    const [clubsLoading,  setClubsLoading]  = useState(true);
    const [togglingId,    setTogglingId]    = useState<string | null>(null);

    const fetchClubs = useCallback(async () => {
        if (!user?.id) return;
        try {
            const [instRes, memberRes] = await Promise.all([
                supabase.from("discount_institutions").select("id,name,logo_url,rules,is_active").eq("is_active", true).order("name"),
                supabase.from("user_institutions").select("institution_id").eq("user_id", user.id).eq("is_active", true),
            ]);
            if (instRes.error) throw instRes.error;
            if (memberRes.error) throw memberRes.error;
            setInstitutions(instRes.data ?? []);
            setMembershipIds(new Set((memberRes.data ?? []).map((m: any) => m.institution_id)));
        } catch {
            toast.error("Error al cargar clubes");
        } finally {
            setClubsLoading(false);
        }
    }, [user?.id]);

    useEffect(() => { fetchClubs(); }, [fetchClubs]);

    const handleToggleClub = async (institutionId: string, currentlyMember: boolean) => {
        if (!user?.id || togglingId) return;
        setTogglingId(institutionId);
        try {
            const result = await toggleInstitutionMembershipAction(user.id, institutionId, !currentlyMember);
            if (!result.success) throw new Error(result.error);
            if (currentlyMember) {
                setMembershipIds(prev => { const n = new Set(prev); n.delete(institutionId); return n; });
                toast.success("Membresía removida");
            } else {
                setMembershipIds(prev => new Set(prev).add(institutionId));
                toast.success("Membresía activada");
            }
        } catch (err: any) {
            toast.error(err?.message || "Error al actualizar membresía");
        } finally {
            setTogglingId(null);
        }
    };

    if (authLoading || !user || !profile) {
        return (
            <div className="flex items-center justify-center h-screen">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
        );
    }

    const initials = getInitials(profile.first_name || user.email?.split("@")[0], profile.last_name);

    return (
        <div className="w-full min-h-screen bg-slate-50 pb-32">
            {/* ── Sticky Header ─────────────────────────────────── */}
            <header className="sticky top-0 bg-white/80 backdrop-blur-xl z-50 border-b border-slate-100 p-4 flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => router.back()} className="rounded-2xl bg-slate-100/50 hover:bg-slate-100">
                    <ArrowLeft className="w-5 h-5 text-slate-600" />
                </Button>
                <div>
                    <h1 className="text-lg font-black tracking-tight text-slate-900 leading-none">Mi Cuenta</h1>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-0.5">Información, seguridad y preferencias</p>
                </div>
            </header>

            <div className="max-w-md mx-auto px-4 space-y-2">

                {/* ══════════════════════════════════════════════════
                    SECCIÓN 1: MI INFORMACIÓN
                ══════════════════════════════════════════════════ */}
                <SectionTitle>Mi Información</SectionTitle>

                {/* Avatar */}
                <div className="flex flex-col items-center py-4">
                    <div className="relative">
                        <div className="h-24 w-24 rounded-[2rem] bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-xl border-4 border-white overflow-hidden ring-4 ring-primary/5">
                            {profile.photo_url ? (
                                <img src={profile.photo_url} alt="Profile" className="w-full h-full object-cover" />
                            ) : (
                                <span className="text-3xl font-black text-primary">{initials}</span>
                            )}
                        </div>
                        <button className="absolute -bottom-2 -right-2 bg-white p-2 rounded-2xl shadow-lg border border-slate-100 text-primary hover:scale-110 transition-transform">
                            <Camera className="w-4 h-4" />
                        </button>
                    </div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-4">
                        Miembro desde {profile.created_at ? new Date(profile.created_at).toLocaleDateString("es-CL", { month: "long", year: "numeric" }) : "---"}
                    </p>
                </div>

                {/* Nombre y alias */}
                <div className="bg-white rounded-[2rem] p-5 shadow-sm border border-slate-100 space-y-4">
                    <div className="space-y-2">
                        <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1 flex items-center gap-2">
                            <Edit3 className="w-3 h-3" /> Nombre Público (Alias)
                        </Label>
                        <Input value={formData.display_name} onChange={e => setFormData(s => ({ ...s, display_name: e.target.value }))}
                            className="h-12 rounded-2xl border-slate-100 bg-slate-50/50 font-bold" placeholder="Ej: Juan Gourmet" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1">Nombre</Label>
                            <Input value={formData.first_name} onChange={e => setFormData(s => ({ ...s, first_name: e.target.value }))}
                                className="h-12 rounded-2xl border-slate-100 bg-slate-50/50 font-bold" />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1">Apellido</Label>
                            <Input value={formData.last_name} onChange={e => setFormData(s => ({ ...s, last_name: e.target.value }))}
                                className="h-12 rounded-2xl border-slate-100 bg-slate-50/50 font-bold" />
                        </div>
                    </div>
                </div>

                {/* Contacto y dirección */}
                <div className="bg-white rounded-[2rem] p-5 shadow-sm border border-slate-100 space-y-4">
                    <div className="space-y-2">
                        <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1 flex items-center gap-2">
                            <Mail className="w-3 h-3" /> Correo Electrónico
                        </Label>
                        <div className="h-12 rounded-2xl bg-slate-50 border border-slate-100 flex items-center px-4 font-bold text-slate-400 gap-3">
                            {user.email}
                            <span className="ml-auto text-xs bg-slate-200/50 px-2 py-0.5 rounded-full">LECTURA</span>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1 flex items-center gap-2">
                            <Phone className="w-3 h-3" /> Nº Celular
                        </Label>
                        <PhoneInput value={formData.phone} onChange={v => setFormData(s => ({ ...s, phone: v }))}
                            className="h-12 rounded-2xl border-slate-100 bg-slate-50/50 font-bold" />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1 flex items-center gap-2">
                            <MapPin className="w-3 h-3" /> Dirección Principal
                        </Label>
                        <AddressAutocomplete
                            onAddressSelect={addr => setFormData(s => ({ ...s, default_address: addr.address, default_address_lat: addr.lat, default_address_lng: addr.lng }))}
                            defaultValue={formData.default_address}
                            placeholder="Tu dirección en Santiago..."
                        />
                    </div>
                </div>

                <Button onClick={handleSaveInfo} disabled={infoLoading}
                    className="w-full h-14 rounded-2xl font-black shadow-lg shadow-primary/20 bg-primary hover:bg-primary/95 active:scale-95 transition-all">
                    {infoLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Guardar Información"}
                </Button>

                {/* ══════════════════════════════════════════════════
                    SECCIÓN 2: SEGURIDAD
                ══════════════════════════════════════════════════ */}
                <SectionTitle>Seguridad</SectionTitle>

                <div className="bg-white rounded-[2rem] p-5 shadow-sm border border-slate-100 space-y-2 text-center">
                    <div className="w-14 h-14 bg-emerald-50 rounded-[1.5rem] flex items-center justify-center mx-auto relative">
                        <ShieldCheck className="w-7 h-7 text-emerald-600 opacity-60" />
                        <div className="absolute -top-1 -right-1 bg-white p-0.5 rounded-full shadow-sm">
                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        </div>
                    </div>
                    <p className="font-black text-slate-800">Cuenta Protegida</p>
                    <p className="text-xs text-slate-400 leading-relaxed">Tu información está cifrada por los estándares de Supabase Auth.</p>
                </div>

                <div className="bg-white rounded-[2rem] p-5 shadow-sm border border-slate-100 space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="bg-primary/10 p-2 rounded-xl text-primary"><Key className="w-4 h-4" /></div>
                        <h3 className="font-black text-slate-800 text-sm">Actualizar Contraseña</h3>
                    </div>
                    <form onSubmit={handleUpdatePassword} className="space-y-3">
                        <div className="space-y-2">
                            <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1">Contraseña Actual</Label>
                            <Input type="password" autoComplete="current-password" value={passwords.current} onChange={e => setPasswords(s => ({ ...s, current: e.target.value }))}
                                className="h-12 rounded-2xl border-slate-100 bg-slate-50/50 font-bold" placeholder="Si ya tienes una" />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1">Nueva Contraseña</Label>
                            <Input type="password" value={passwords.new} onChange={e => setPasswords(s => ({ ...s, new: e.target.value }))}
                                className="h-12 rounded-2xl border-slate-100 bg-slate-50/50 font-bold" placeholder="8+ caracteres, con letra y número" />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1">Confirmar Contraseña</Label>
                            <Input type="password" value={passwords.confirm} onChange={e => setPasswords(s => ({ ...s, confirm: e.target.value }))}
                                className="h-12 rounded-2xl border-slate-100 bg-slate-50/50 font-bold" placeholder="Repite la contraseña" />
                        </div>
                        <Button type="submit" disabled={secLoading || !passwords.new}
                            className="w-full h-12 rounded-2xl font-black bg-primary hover:bg-primary/95 shadow-md shadow-primary/20 active:scale-95 transition-all">
                            {secLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Actualizar Acceso"}
                        </Button>
                    </form>
                </div>

                <div className="bg-rose-50/50 border border-rose-100 rounded-[2rem] p-5 space-y-3">
                    <div>
                        <h3 className="font-black text-rose-800 text-sm flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" /> Sesiones Activas
                        </h3>
                        <p className="text-xs text-rose-500 font-bold uppercase tracking-wider mt-0.5">¿Dispositivo compartido?</p>
                    </div>
                    <Button variant="ghost" onClick={handleSignOut}
                        className="w-full h-12 rounded-2xl font-black gap-3 text-rose-600 hover:bg-rose-100/50 border border-rose-200/50">
                        <LogOut className="w-4 h-4" /> Cerrar Sesión Global
                    </Button>
                    <p className="text-xs text-center text-rose-400 font-bold uppercase tracking-widest">
                        Al cerrar sesión se perderá el acceso en este navegador.
                    </p>
                </div>

                {/* ══════════════════════════════════════════════════
                    SECCIÓN 3: NOTIFICACIONES
                ══════════════════════════════════════════════════ */}
                <SectionTitle>Notificaciones</SectionTitle>

                <div className="bg-white rounded-[2rem] p-5 shadow-sm border border-slate-100 space-y-4">
                    <h3 className="font-black text-slate-800">Canales de Alerta</h3>
                    <p className="text-sm text-slate-400 leading-relaxed">Todas las alertas se registran en tu cuenta. Próximamente más canales.</p>
                    <div className="space-y-2 pt-1">
                        {[
                            { icon: Smartphone,    label: "App",        badge: "Configurado",  color: "bg-slate-200 text-slate-500" },
                            { icon: Mail,          label: "Email",      badge: "Activo",       color: "bg-emerald-100 text-emerald-600" },
                            { icon: MessageSquare, label: "WhatsApp",   badge: "Próximamente", color: "bg-amber-100 text-amber-600" },
                        ].map(ch => (
                            <div key={ch.label} className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl">
                                <div className="flex items-center gap-3">
                                    <ch.icon className="w-4 h-4 text-slate-400" />
                                    <span className="text-sm font-bold text-slate-600">{ch.label}</span>
                                </div>
                                <span className={`text-xs font-black px-2 py-0.5 rounded uppercase ${ch.color}`}>{ch.badge}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* ══════════════════════════════════════════════════
                    SECCIÓN 4: CLUBES DE DESCUENTOS
                ══════════════════════════════════════════════════ */}
                <SectionTitle>Clubes de Descuentos</SectionTitle>

                {clubsLoading ? (
                    <div className="flex justify-center py-10">
                        <Loader2 className="w-7 h-7 animate-spin text-primary" />
                    </div>
                ) : institutions.length === 0 ? (
                    <div className="bg-white rounded-[2rem] p-10 text-center border border-slate-100 shadow-sm space-y-3">
                        <Building2 className="w-9 h-9 text-slate-200 mx-auto" />
                        <p className="text-slate-400 font-bold text-sm">No hay instituciones disponibles</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {institutions.map(inst => {
                            const isMember   = membershipIds.has(inst.id);
                            const isToggling = togglingId === inst.id;
                            return (
                                <div key={inst.id} className="p-4 bg-white border border-slate-100 rounded-3xl flex items-center gap-4 shadow-sm">
                                    <div className="h-11 w-11 rounded-2xl bg-muted flex items-center justify-center overflow-hidden shrink-0">
                                        {inst.logo_url ? <img src={inst.logo_url} alt={inst.name} className="w-full h-full object-cover" /> : <Building2 className="w-5 h-5 text-muted-foreground" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-bold text-foreground truncate text-sm">{inst.name}</p>
                                        {inst.rules && <p className="text-xs text-muted-foreground line-clamp-1">{inst.rules}</p>}
                                    </div>
                                    <button disabled={isToggling} onClick={() => handleToggleClub(inst.id, isMember)}
                                        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${isMember ? "bg-primary" : "bg-muted"} ${isToggling ? "opacity-50" : ""}`}>
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${isMember ? "translate-x-5" : "translate-x-0"}`} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

            </div>
        </div>
    );
}
