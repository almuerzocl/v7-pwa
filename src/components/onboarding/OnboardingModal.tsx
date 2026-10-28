"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { AddressAutocomplete } from "@/components/ui/AddressAutocomplete";
import {
    ChevronRight, ChevronLeft, Check, Loader2,
    MapPin, Building2, Utensils, UserCircle, Sparkles
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { stripRegionAndCountry } from "@/lib/address-format";
import PhoneInput, { formatChileanPhone } from "@/components/ui/PhoneInput";
import { toggleInstitutionMembershipAction } from "@/app/actions/discount-actions";
import toast from "react-hot-toast";

interface DiscountInstitution {
    id: string;
    name: string;
    logo_url: string | null;
    rules: string | null;
    is_active: boolean;
}

import { trackPlatformEvent } from "@/lib/platform-events";

const TOTAL_STEPS = 5;
const STEP_NAMES = ["bienvenida", "datos", "ubicacion", "clubes", "listo"];

export function OnboardingModal() {
    const { user, profile, isLoading, refreshProfile } = useAuth();
    const [visible, setVisible] = useState(false);
    // "Completar después" solo oculta el modal durante esta sesión de la app: al volver a abrirla
    // (recarga / nueva apertura) el estado se reinicia y el modal reaparece hasta terminar.
    const [dismissed, setDismissed] = useState(false);
    const [step, setStep] = useState(1);
    const [saving, setSaving] = useState(false);
    const [animating, setAnimating] = useState(false);
    const initialized = useRef(false);

    const [formData, setFormData] = useState({
        first_name: "",
        last_name: "",
        display_name: "",
        phone: "",
    });

    const [addressData, setAddressData] = useState({
        address: "",
        lat: 0,
        lng: 0,
    });

    const [institutions, setInstitutions] = useState<DiscountInstitution[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    // Clubes ya guardados en la base: permite guardar solo las diferencias en cada paso.
    const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
    const [loadingInstitutions, setLoadingInstitutions] = useState(false);

    // Inicializa el formulario UNA vez con lo ya grabado y retoma en el primer paso pendiente.
    useEffect(() => {
        if (isLoading || !user || !profile) return;
        // Se muestra si el onboarding está pendiente (cualquier rol, como hasta ahora) o, solo para
        // comensales (role USER), si quedó marcado como completo pero faltan los datos básicos
        // (p. ej. usó "Completar después" antes del guardado progresivo).
        const basicsMissing = !(
            profile.first_name?.trim() &&
            profile.last_name?.trim() &&
            (profile.phone || (profile as any).phone_number || "").trim()
        );
        const pending = profile.onboarding_completed === false;
        if (!pending && !(profile.role === "USER" && basicsMissing)) return;
        if (!initialized.current) {
            initialized.current = true;
            const first_name = profile.first_name || "";
            const last_name = profile.last_name || "";
            const phone = profile.phone || (profile as any).phone_number || "";
            const address = profile.default_address ? stripRegionAndCountry(profile.default_address) : "";
            setFormData({ first_name, last_name, display_name: profile.display_name || "", phone });
            setAddressData({
                address,
                lat: profile.default_address_lat || 0,
                lng: profile.default_address_lng || 0,
            });
            const basicsDone = !!(first_name.trim() && last_name.trim() && phone.trim());
            const hasProgress = !!(first_name || last_name || phone || address);
            setStep(!hasProgress ? 1 : !basicsDone ? 2 : !address ? 3 : 4);
            supabase
                .from("user_institutions")
                .select("institution_id")
                .eq("user_id", user.id)
                .eq("is_active", true)
                .then(({ data }) => {
                    const ids = new Set<string>((data ?? []).map((m: any) => m.institution_id));
                    setSelectedIds(new Set(ids));
                    setSavedIds(ids);
                });
        }
        setVisible(true);
    }, [isLoading, user, profile]);

    useEffect(() => {
        if (step === 4) fetchInstitutions();
    }, [step]);

    // Embudo del alta: un evento por paso visto (una vez por sesión de la app).
    useEffect(() => {
        if (visible && !dismissed) trackPlatformEvent("onboarding_step", { step: STEP_NAMES[step - 1], props: { step_index: step }, once: true });
    }, [visible, dismissed, step]);

    const fetchInstitutions = async () => {
        setLoadingInstitutions(true);
        try {
            const { data } = await supabase
                .from("discount_institutions")
                .select("id,name,logo_url,rules,is_active")
                .eq("is_active", true)
                .order("name");
            setInstitutions(data || []);
        } finally {
            setLoadingInstitutions(false);
        }
    };

    const toggleInstitution = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const goTo = (next: number) => {
        setAnimating(true);
        setTimeout(() => {
            setStep(next);
            setAnimating(false);
        }, 150);
    };

    /**
     * Graba lo entregado hasta ahora (solo campos con valor, nunca pisa datos con vacío).
     * markComplete=true además cierra el onboarding. Devuelve false si algo crítico falló.
     */
    const persist = async (markComplete: boolean): Promise<boolean> => {
        if (!user) return false;

        const payload: Record<string, unknown> = {};
        if (formData.first_name.trim()) payload.first_name = formData.first_name.trim();
        if (formData.last_name.trim()) payload.last_name = formData.last_name.trim();
        if (formData.display_name.trim()) payload.display_name = formData.display_name.trim();
        if (formData.phone.trim()) {
            // phone y phone_number se escriben juntos: takeaway, checkout y búsqueda de
            // invitados leen phone_number primero (igual que /profile/info).
            payload.phone = formData.phone;
            payload.phone_number = formData.phone;
        }
        if (addressData.address) {
            payload.default_address = addressData.address;
            payload.default_address_lat = addressData.lat || null;
            payload.default_address_lng = addressData.lng || null;
        }
        if (markComplete) payload.onboarding_completed = true;

        if (Object.keys(payload).length > 0) {
            const { error } = await supabase.from("profiles").update(payload).eq("id", user.id);
            if (error) {
                console.error("Onboarding: error guardando perfil", error);
                toast.error("No pudimos guardar tus datos. Intenta nuevamente.");
                return false;
            }
        }

        // user_institutions solo admite escritura vía service_role (server action).
        const toAdd = Array.from(selectedIds).filter(id => !savedIds.has(id));
        const toRemove = Array.from(savedIds).filter(id => !selectedIds.has(id));
        if (toAdd.length || toRemove.length) {
            const ops = [
                ...toAdd.map(id => ({ id, join: true })),
                ...toRemove.map(id => ({ id, join: false })),
            ];
            const results = await Promise.all(
                ops.map(o => toggleInstitutionMembershipAction(user.id, o.id, o.join))
            );
            const nextSaved = new Set(savedIds);
            results.forEach((r, i) => {
                if (!r.success) return;
                if (ops[i].join) nextSaved.add(ops[i].id); else nextSaved.delete(ops[i].id);
            });
            setSavedIds(nextSaved);
            if (results.some(r => !r.success)) {
                toast.error("No pudimos guardar algunos clubes. Puedes hacerlo desde Mi Cuenta.");
            }
        }

        await refreshProfile();
        return true;
    };

    const advance = async (next: number) => {
        setSaving(true);
        try {
            if (await persist(false)) goTo(next);
        } finally {
            setSaving(false);
        }
    };

    const handleComplete = async () => {
        setSaving(true);
        try {
            if (await persist(true)) {
                trackPlatformEvent("onboarding_complete");
                setVisible(false);
            }
        } finally {
            setSaving(false);
        }
    };

    // "Completar después": graba lo avanzado, NO marca el onboarding como completo y oculta el
    // modal solo hasta la próxima apertura de la app.
    const handleSkipAll = async () => {
        setSaving(true);
        try {
            if (await persist(false)) {
                trackPlatformEvent("onboarding_step", { step: "omitido", props: { step_index: step } });
                setDismissed(true);
                toast("Te recordaremos completar tus datos la próxima vez que abras la app.");
            }
        } finally {
            setSaving(false);
        }
    };

    if (!visible || dismissed) return null;

    const canAdvanceStep2 = formData.first_name.trim().length > 0 && formData.last_name.trim().length > 0 && formData.phone.trim().length > 0;

    return (
        <div className="fixed inset-0 z-[99999] flex items-end sm:items-center justify-center">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

            {/* Modal */}
            <div className="relative w-full sm:max-w-md sm:mx-4 bg-background sm:rounded-[2.5rem] rounded-t-[2.5rem] shadow-2xl overflow-hidden max-h-[92dvh] flex flex-col">

                {/* Progress + skip */}
                <div className="flex items-center justify-between px-6 pt-6 pb-2 shrink-0">
                    <div className="flex items-center gap-1.5">
                        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                            <div
                                key={i}
                                className={cn(
                                    "h-1.5 rounded-full transition-all duration-300",
                                    i < step
                                        ? "bg-primary w-6"
                                        : i === step - 1
                                            ? "bg-primary w-8"
                                            : "bg-muted w-4"
                                )}
                            />
                        ))}
                    </div>
                    {step < 5 && (
                        <button
                            onClick={handleSkipAll}
                            disabled={saving}
                            className="min-h-11 px-3 text-xs font-bold text-slate-600 hover:text-foreground transition-colors uppercase tracking-wider"
                        >
                            Completar después
                        </button>
                    )}
                </div>

                {/* Step content */}
                <div
                    className={cn(
                        "flex-1 overflow-y-auto px-6 pb-6 transition-opacity duration-150",
                        animating ? "opacity-0" : "opacity-100"
                    )}
                >
                    {/* ── Step 1: Bienvenida ── */}
                    {step === 1 && (
                        <div className="flex flex-col items-center text-center pt-6 pb-2 space-y-5">
                            <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center shadow-inner">
                                <Utensils className="w-10 h-10 text-primary" />
                            </div>
                            <div className="space-y-2">
                                <h1 className="text-2xl font-black tracking-tight text-foreground">
                                    ¡Bienvenido/a a<br />Almuerzo.cl!
                                </h1>
                                <p className="text-sm text-muted-foreground leading-relaxed max-w-[280px] mx-auto">
                                    Reserva mesas, pide para llevar y descubre los mejores almuerzos cerca de tu trabajo.
                                </p>
                            </div>
                            <div className="w-full bg-muted/40 rounded-2xl p-4 text-left space-y-3">
                                {[
                                    { icon: UserCircle, text: "Completa tu perfil en 2 minutos" },
                                    { icon: MapPin,     text: "Configura tu dirección habitual" },
                                    { icon: Building2,  text: "Activa tus descuentos corporativos" },
                                ].map(({ icon: Icon, text }) => (
                                    <div key={text} className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                                            <Icon className="w-4 h-4 text-primary" />
                                        </div>
                                        <p className="text-sm font-medium text-foreground">{text}</p>
                                    </div>
                                ))}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Conectado como <span className="font-bold">{user?.email}</span>
                            </p>
                        </div>
                    )}

                    {/* ── Step 2: Mi Información ── */}
                    {step === 2 && (
                        <div className="pt-4 space-y-5">
                            <div>
                                <h2 className="text-xl font-black tracking-tight">Tu Información</h2>
                                <p className="text-[12px] text-muted-foreground mt-1">¿Cómo te llamamos? Esto aparece en tus reservas y pedidos.</p>
                            </div>

                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
                                            Nombre <span className="text-destructive">*</span>
                                        </Label>
                                        <Input
                                            placeholder="Juan"
                                            className="h-12 bg-muted/30 border-transparent rounded-xl focus-visible:ring-primary/20"
                                            value={formData.first_name}
                                            onChange={e => setFormData({ ...formData, first_name: e.target.value })}
                                            autoFocus
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
                                            Apellido <span className="text-destructive">*</span>
                                        </Label>
                                        <Input
                                            placeholder="Pérez"
                                            className="h-12 bg-muted/30 border-transparent rounded-xl focus-visible:ring-primary/20"
                                            value={formData.last_name}
                                            onChange={e => setFormData({ ...formData, last_name: e.target.value })}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-1.5">
                                    <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
                                        Nombre público / Alias <span className="text-muted-foreground/50 normal-case tracking-normal font-normal">(opcional)</span>
                                    </Label>
                                    <Input
                                        placeholder="ej: Juanito"
                                        className="h-12 bg-muted/30 border-transparent rounded-xl focus-visible:ring-primary/20"
                                        value={formData.display_name}
                                        onChange={e => setFormData({ ...formData, display_name: e.target.value })}
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
                                        Teléfono / WhatsApp <span className="text-destructive">*</span>
                                    </Label>
                                    <PhoneInput
                                        className="h-12 bg-muted/30 border-transparent rounded-xl focus-visible:ring-primary/20"
                                        value={formData.phone}
                                        onChange={v => setFormData({ ...formData, phone: v })}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── Step 3: Mi Ubicación ── */}
                    {step === 3 && (
                        <div className="pt-4 space-y-5">
                            <div>
                                <h2 className="text-xl font-black tracking-tight">Tu Ubicación Habitual</h2>
                                <p className="text-[12px] text-muted-foreground mt-1">
                                    Te mostramos los restaurantes más cercanos a donde almuerzas cada día.
                                </p>
                            </div>

                            <AddressAutocomplete
                                defaultValue={addressData.address}
                                placeholder="Busca tu calle o sector..."
                                onAddressSelect={({ address, lat, lng }) =>
                                    setAddressData({ address, lat, lng })
                                }
                            />

                            {addressData.address && (
                                <div className="flex items-center gap-2 bg-primary/5 border border-primary/15 rounded-2xl px-4 py-3">
                                    <MapPin className="w-4 h-4 text-primary shrink-0" />
                                    <p className="text-[12px] font-medium text-foreground leading-snug">{addressData.address}</p>
                                </div>
                            )}

                            <p className="text-xs text-muted-foreground text-center">
                                Puedes cambiar esto en cualquier momento desde la app.
                            </p>
                        </div>
                    )}

                    {/* ── Step 4: Clubes de Descuento ── */}
                    {step === 4 && (
                        <div className="pt-4 space-y-5">
                            <div>
                                <h2 className="text-xl font-black tracking-tight">Clubes de Descuento</h2>
                                <p className="text-[12px] text-muted-foreground mt-1">
                                    ¿Perteneces a alguna de estas instituciones? Activa los que aplican para ti.
                                </p>
                            </div>

                            {loadingInstitutions ? (
                                <div className="flex items-center justify-center py-10">
                                    <Loader2 className="w-6 h-6 text-primary animate-spin" />
                                </div>
                            ) : institutions.length === 0 ? (
                                <div className="text-center py-10 text-sm text-muted-foreground">
                                    No hay instituciones disponibles por ahora.
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {institutions.map(inst => {
                                        const active = selectedIds.has(inst.id);
                                        return (
                                            <div
                                                key={inst.id}
                                                onClick={() => toggleInstitution(inst.id)}
                                                className={cn(
                                                    "flex items-center gap-4 p-4 rounded-2xl border cursor-pointer transition-all select-none",
                                                    active
                                                        ? "bg-primary/5 border-primary/25 shadow-sm"
                                                        : "bg-background border-border hover:border-primary/20"
                                                )}
                                            >
                                                {inst.logo_url ? (
                                                    <img
                                                        src={inst.logo_url}
                                                        alt={inst.name}
                                                        className="w-10 h-10 rounded-xl object-contain bg-white border border-border p-1 shrink-0"
                                                    />
                                                ) : (
                                                    <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
                                                        <Building2 className="w-5 h-5 text-muted-foreground" />
                                                    </div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <p className="font-bold text-sm text-foreground truncate">{inst.name}</p>
                                                    {inst.rules && (
                                                        <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{inst.rules}</p>
                                                    )}
                                                </div>
                                                <div className={cn(
                                                    "w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
                                                    active ? "bg-primary border-primary" : "border-muted-foreground/30"
                                                )}>
                                                    {active && <Check className="w-3 h-3 text-white" />}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {selectedIds.size > 0 && (
                                <p className="text-center text-xs font-bold text-primary">
                                    {selectedIds.size} institución{selectedIds.size !== 1 ? "es" : ""} seleccionada{selectedIds.size !== 1 ? "s" : ""}
                                </p>
                            )}
                        </div>
                    )}

                    {/* ── Step 5: ¡Listo! ── */}
                    {step === 5 && (
                        <div className="flex flex-col items-center text-center pt-6 pb-2 space-y-5">
                            <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center shadow-inner animate-in zoom-in duration-300">
                                <Check className="w-10 h-10 text-green-600" strokeWidth={3} />
                            </div>
                            <div className="space-y-2">
                                <h2 className="text-2xl font-black tracking-tight">¡Todo listo!</h2>
                                <p className="text-sm text-muted-foreground max-w-[260px] mx-auto leading-relaxed">
                                    Tu perfil está configurado. Ahora puedes explorar restaurantes y hacer tus primeras reservas.
                                </p>
                            </div>

                            {/* Summary */}
                            <div className="w-full bg-muted/30 rounded-2xl p-4 text-left space-y-2.5">
                                {(formData.first_name || formData.last_name) && (
                                    <div className="flex items-center gap-2 text-sm">
                                        <UserCircle className="w-4 h-4 text-primary shrink-0" />
                                        <span className="font-medium">{[formData.first_name, formData.last_name].filter(Boolean).join(" ")}</span>
                                    </div>
                                )}
                                {addressData.address && (
                                    <div className="flex items-center gap-2 text-sm">
                                        <MapPin className="w-4 h-4 text-primary shrink-0" />
                                        <span className="font-medium line-clamp-1">{addressData.address}</span>
                                    </div>
                                )}
                                {selectedIds.size > 0 && (
                                    <div className="flex items-center gap-2 text-sm">
                                        <Building2 className="w-4 h-4 text-primary shrink-0" />
                                        <span className="font-medium">
                                            {selectedIds.size} club{selectedIds.size !== 1 ? "es" : ""} de descuento activado{selectedIds.size !== 1 ? "s" : ""}
                                        </span>
                                    </div>
                                )}
                                <div className="flex items-center gap-2 text-sm">
                                    <Sparkles className="w-4 h-4 text-primary shrink-0" />
                                    <span className="font-medium">Puedes editar todo desde Mi Cuenta</span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Navigation buttons */}
                <div className="px-6 pb-8 pt-2 shrink-0 space-y-2">
                    {step === 1 && (
                        <Button
                            className="w-full h-14 rounded-2xl font-black text-base shadow-lg shadow-primary/15"
                            onClick={() => goTo(2)}
                        >
                            Comenzar
                            <ChevronRight className="w-5 h-5 ml-1" />
                        </Button>
                    )}

                    {step === 2 && (
                        <div className="space-y-2">
                            <Button
                                className="w-full h-14 rounded-2xl font-black text-base"
                                onClick={() => advance(3)}
                                disabled={!canAdvanceStep2 || saving}
                            >
                                Continuar
                                <ChevronRight className="w-5 h-5 ml-1" />
                            </Button>
                            <Button variant="ghost" className="w-full h-10 rounded-2xl text-sm font-bold text-muted-foreground" onClick={() => goTo(1)}>
                                <ChevronLeft className="w-4 h-4 mr-1" /> Volver
                            </Button>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-2">
                            <Button
                                className="w-full h-14 rounded-2xl font-black text-base"
                                disabled={saving}
                                onClick={() => advance(4)}
                            >
                                {addressData.address ? "Continuar" : "Saltar por ahora"}
                                <ChevronRight className="w-5 h-5 ml-1" />
                            </Button>
                            <Button variant="ghost" className="w-full h-10 rounded-2xl text-sm font-bold text-muted-foreground" onClick={() => goTo(2)}>
                                <ChevronLeft className="w-4 h-4 mr-1" /> Volver
                            </Button>
                        </div>
                    )}

                    {step === 4 && (
                        <div className="space-y-2">
                            <Button
                                className="w-full h-14 rounded-2xl font-black text-base"
                                disabled={saving}
                                onClick={() => advance(5)}
                            >
                                {selectedIds.size > 0 ? `Continuar (${selectedIds.size} seleccionado${selectedIds.size !== 1 ? "s" : ""})` : "Saltar por ahora"}
                                <ChevronRight className="w-5 h-5 ml-1" />
                            </Button>
                            <Button variant="ghost" className="w-full h-10 rounded-2xl text-sm font-bold text-muted-foreground" onClick={() => goTo(3)}>
                                <ChevronLeft className="w-4 h-4 mr-1" /> Volver
                            </Button>
                        </div>
                    )}

                    {step === 5 && (
                        <Button
                            className="w-full h-14 rounded-2xl font-black text-base shadow-lg shadow-primary/15"
                            onClick={handleComplete}
                            disabled={saving}
                        >
                            {saving ? (
                                <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Guardando...</>
                            ) : (
                                <>¡Empezar a explorar! <Sparkles className="w-5 h-5 ml-2" /></>
                            )}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
