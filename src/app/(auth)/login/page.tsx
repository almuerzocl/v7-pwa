"use client";

export const dynamic = 'force-dynamic';

import { useState, useEffect, useMemo, Suspense } from "react";
import { trackPlatformEvent } from "@/lib/platform-events";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    ArrowRight,
    Eye,
    EyeOff,
    UserPlus,
    AlertCircle,
    Mail,
    Lock,
    User as UserIcon,
    ChevronLeft,
    Sparkles,
    CheckCircle2
} from "lucide-react";
import toast from "react-hot-toast";
import { googleSectionFor, googleErrorMessage, GOOGLE_CALLBACK_ERRORS } from "@/lib/auth-google";
import { safeNext } from "@/lib/safe-next";
import { validateRegister, PASSWORD_RULES_TEXT } from "@/lib/register-validation";
import { ELITE_PRODUCT_URL } from "@/lib/elite";

type AuthMode = "login" | "register" | "magic-link" | "forgot-password" | "sent";

function sanitizeRedirect(raw: string | null | undefined): string {
    return safeNext(raw);
}

export default function LoginPage() {
    return (
        <Suspense>
            <LoginPageContent />
        </Suspense>
    );
}

function LoginPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();

    const redirectTarget = useMemo(
        () => sanitizeRedirect(searchParams?.get("redirect")),
        [searchParams]
    );

    // ?mode=register abre directo el formulario de registro (enlace desde el sitio de Cri-Olla).
    const [authMode, setAuthMode] = useState<AuthMode>(
        searchParams?.get("mode") === "register" ? "register" : "login"
    );
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isPasswordVisible, setIsPasswordVisible] = useState(false);
    const [pageError, setPageError] = useState<string | null>(null);
    const [sentMode, setSentMode] = useState<"magic-link" | "forgot-password" | "register">("magic-link");

    useEffect(() => {
        const err = searchParams?.get("error");
        if (err === "incomplete_profile") {
            supabase.auth.signOut().catch(() => { });
        }
        if (err && GOOGLE_CALLBACK_ERRORS[err]) setPageError(GOOGLE_CALLBACK_ERRORS[err]);
    }, [searchParams]);

    const buildCallbackUrl = () => {
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        return `${origin}/auth/callback?next=${encodeURIComponent(redirectTarget)}`;
    };

    const goBack = () => {
        setAuthMode("login");
        setPassword("");
        setConfirmPassword("");
        setPageError(null);
    };

    // --- Handlers ---

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email.trim() || !password.trim()) {
            toast.error("Por favor, ingresa tus credenciales");
            return;
        }
        setIsLoading(true);
        try {
            const { error } = await supabase.auth.signInWithPassword({
                email: email.trim(),
                password,
            });
            if (error) throw error;
            toast.success("¡Bienvenido de vuelta!");
            trackPlatformEvent("login", { props: { source: "password" } });
            window.location.href = redirectTarget;
        } catch (err: any) {
            toast.error(err.message || "Error al iniciar sesión");
            setIsLoading(false);
        }
    };

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        const check = validateRegister({ firstName, lastName, email, password, confirmPassword });
        if (!check.ok) {
            toast.error(check.error);
            return;
        }
        setIsLoading(true);
        try {
            const { error } = await supabase.auth.signUp({
                email: email.trim(),
                password,
                options: {
                    emailRedirectTo: buildCallbackUrl(),
                    data: {
                        first_name: firstName.trim(),
                        last_name: lastName.trim(),
                        full_name: `${firstName.trim()} ${lastName.trim()}`
                    }
                }
            });
            if (error) throw error;
            setSentMode("register");
            setAuthMode("sent");
        } catch (err: any) {
            toast.error(err.message || "Error al crear la cuenta");
        } finally {
            setIsLoading(false);
        }
    };

    const handleGoogleLogin = async () => {
        setIsLoading(true);
        try {
            const { error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: {
                    redirectTo: buildCallbackUrl(),
                    queryParams: { access_type: "offline", prompt: "consent" },
                },
            });
            if (error) throw error;
        } catch (err: any) {
            toast.error(googleErrorMessage(err));
            setIsLoading(false);
        }
    };

    const handleMagicLink = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email.trim()) {
            toast.error("Ingresa tu correo electrónico");
            return;
        }
        setIsLoading(true);
        try {
            const res = await fetch("/api/auth/enlace-magico", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: email.trim(), next: redirectTarget }),
            });
            if (res.status === 429) {
                toast.error("Demasiados intentos. Espera un rato antes de volver a pedir el enlace.");
                return;
            }
            if (!res.ok) throw new Error("No pudimos enviar el enlace. Inténtalo de nuevo.");
            setSentMode("magic-link");
            setAuthMode("sent");
        } catch (err: any) {
            toast.error(err.message || "Error al enviar el link");
        } finally {
            setIsLoading(false);
        }
    };

    const handleForgotPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email.trim()) {
            toast.error("Ingresa tu correo electrónico");
            return;
        }
        setIsLoading(true);
        try {
            const res = await fetch("/api/auth/recuperar", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: email.trim() }),
            });
            if (res.status === 429) {
                toast.error("Demasiados intentos. Espera un rato antes de volver a pedir el enlace.");
                return;
            }
            if (!res.ok) throw new Error("No pudimos procesar la solicitud. Inténtalo de nuevo.");
            setSentMode("forgot-password");
            setAuthMode("sent");
        } catch (err: any) {
            toast.error(err.message || "Error al enviar el correo");
        } finally {
            setIsLoading(false);
        }
    };

    // --- Sent state copy ---
    const sentCopy = {
        "magic-link": {
            title: "Revisa tu correo",
            body: `Enviamos un enlace de acceso a ${email}. Úsalo para ingresar sin contraseña.`,
        },
        "forgot-password": {
            title: "Revisa tu correo",
            body: `Si ${email} está registrado, recibirás un enlace para restablecer tu contraseña.`,
        },
        "register": {
            title: "Revisa tu correo",
            body: `Enviamos un enlace de confirmación a ${email}. Ábrelo para activar tu cuenta.`,
        },
    }[sentMode];

    const googleSection = googleSectionFor(authMode);
    const googleButton = googleSection && (
        <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={isLoading}
            className="w-full h-14 rounded-2xl border border-zinc-200 bg-white hover:bg-zinc-50 active:scale-[0.98] transition-all flex items-center justify-center gap-3 font-bold text-zinc-700 text-sm shadow-sm disabled:opacity-50"
        >
            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            {googleSection.buttonLabel}
        </button>
    );

    return (
        <div className="min-h-[100dvh] flex flex-col bg-zinc-50 font-sans selection:bg-orange-100 selection:text-orange-900">
            <div className="fixed inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-orange-500/10 rounded-full blur-[120px]" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-amber-500/10 rounded-full blur-[120px]" />
            </div>

            <div className="flex-1 flex flex-col items-center justify-center p-8 relative z-10">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center"
                >
                    <div className="w-24 h-24 bg-white rounded-[2rem] shadow-2xl flex items-center justify-center p-4 mb-6 transform rotate-[-3deg]">
                        <Image src="/images/logo.png" alt="Logo" width={64} height={64} className="w-full h-auto" priority unoptimized />
                    </div>
                    <h1 className="text-4xl font-black tracking-tighter text-zinc-900 mb-2">
                        Almuerzo<span className="text-orange-500">.cl</span>
                    </h1>
                    <p className="text-zinc-600 font-bold uppercase tracking-[0.2em] text-xs">
                        Evolución Gastronómica
                    </p>
                </motion.div>
            </div>

            <motion.div
                layout
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ type: "spring", damping: 25, stiffness: 200 }}
                className="bg-white w-full max-w-md mx-auto rounded-t-[3.5rem] shadow-[0_-20px_40px_-15px_rgba(0,0,0,0.05)] border-t border-white p-8 sm:p-12 pb-16 relative z-20"
            >
                {/* Sent confirmation state (magic-link, forgot-password, register) */}
                {authMode === "sent" ? (
                    <div className="space-y-6 text-center py-4">
                        <div className="mx-auto w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center">
                            <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-2xl font-black text-zinc-900 leading-tight">{sentCopy.title}</h2>
                            <p className="text-sm text-zinc-500 font-medium leading-relaxed max-w-sm mx-auto">
                                {sentCopy.body}
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            onClick={goBack}
                            className="h-12 rounded-2xl border-zinc-100 font-bold hover:bg-zinc-50 text-zinc-600"
                        >
                            Volver al Ingreso
                        </Button>
                    </div>
                ) : (
                    <>
                        {/* Mode header */}
                        <div className="flex justify-between items-center mb-10">
                            <div className="space-y-1">
                                <h2 className="text-2xl font-black text-zinc-900 leading-tight">
                                    {authMode === "login" && "Inicia Sesión"}
                                    {authMode === "register" && "Crea tu Cuenta"}
                                    {authMode === "magic-link" && "Acceso Rápido"}
                                    {authMode === "forgot-password" && "¿Olvidaste tu clave?"}
                                </h2>
                                <p className="text-xs text-zinc-400 font-bold uppercase tracking-wider">
                                    {authMode === "login" && "Bienvenido de vuelta"}
                                    {authMode === "register" && "Cuenta gratis"}
                                    {authMode === "magic-link" && "Ingresa sin contraseña"}
                                    {authMode === "forgot-password" && "Te enviamos un enlace"}
                                </p>
                                {authMode === "register" && (
                                    <a
                                        href={ELITE_PRODUCT_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs font-bold text-orange-600 hover:underline"
                                    >
                                        Conoce Elite en la tienda →
                                    </a>
                                )}
                            </div>
                            {authMode !== "login" && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={goBack}
                                    className="rounded-full h-10 w-10 bg-zinc-50 text-zinc-400 hover:text-zinc-900"
                                >
                                    <ChevronLeft className="w-5 h-5" />
                                </Button>
                            )}
                        </div>

                        {pageError && (
                            <div className="mb-6 p-4 bg-rose-50 border border-rose-100 rounded-2xl flex items-start gap-3">
                                <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                                <p className="text-xs font-bold text-rose-900">{pageError}</p>
                            </div>
                        )}

                        {googleSection?.placement === "top" && (
                            <div className="mb-6 space-y-4">
                                {googleButton}
                                <div className="relative">
                                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-zinc-100" /></div>
                                    <div className="relative flex justify-center text-xs uppercase font-black text-zinc-500 tracking-widest">
                                        <span className="bg-white px-4">{googleSection.dividerLabel}</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        <form
                            onSubmit={
                                authMode === "login" ? handleLogin :
                                authMode === "register" ? handleRegister :
                                authMode === "magic-link" ? handleMagicLink :
                                handleForgotPassword
                            }
                            className="space-y-5"
                        >
                            {/* Register name fields */}
                            <AnimatePresence mode="wait">
                                {authMode === "register" && (
                                    <motion.div
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: 20 }}
                                        className="grid grid-cols-2 gap-4"
                                    >
                                        <div className="space-y-2">
                                            <Label htmlFor="auth-first-name" className="text-xs uppercase font-black text-zinc-600 tracking-widest ml-1">Nombre</Label>
                                            <div className="relative">
                                                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-300" />
                                                <Input
                                                    id="auth-first-name" name="given-name" autoComplete="given-name"
                                                    value={firstName}
                                                    onChange={(e) => setFirstName(e.target.value)}
                                                    placeholder="Tu nombre"
                                                    className="h-14 pl-10 bg-zinc-50 border-transparent focus:bg-white focus:ring-2 focus:ring-orange-500/10 transition-all rounded-2xl font-bold"
                                                />
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <Label htmlFor="auth-last-name" className="text-xs uppercase font-black text-zinc-600 tracking-widest ml-1">Apellido</Label>
                                            <Input
                                                id="auth-last-name" name="family-name" autoComplete="family-name"
                                                value={lastName}
                                                onChange={(e) => setLastName(e.target.value)}
                                                placeholder="Tu apellido"
                                                className="h-14 bg-zinc-50 border-transparent focus:bg-white focus:ring-2 focus:ring-orange-500/10 transition-all rounded-2xl font-bold"
                                            />
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>

                            {/* Email */}
                            <div className="space-y-2">
                                <Label htmlFor="auth-email" className="text-xs uppercase font-black text-zinc-600 tracking-widest ml-1">Email</Label>
                                <div className="relative">
                                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-300" />
                                    <Input
                                        type="email"
                                        id="auth-email" name="email" autoComplete="email" inputMode="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="tu@correo.cl"
                                        className="h-14 pl-11 bg-zinc-50 border-transparent focus:bg-white focus:ring-2 focus:ring-orange-500/10 transition-all rounded-2xl font-bold"
                                    />
                                </div>
                            </div>

                            {/* Password (login + register only) */}
                            <AnimatePresence mode="wait">
                                {(authMode === "login" || authMode === "register") && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: "auto" }}
                                        exit={{ opacity: 0, height: 0 }}
                                        className="space-y-2"
                                    >
                                        <div className="flex justify-between items-center ml-1">
                                            <Label htmlFor="auth-password" className="text-xs uppercase font-black text-zinc-600 tracking-widest">Contraseña</Label>
                                            {authMode === "login" && (
                                                <button
                                                    type="button"
                                                    onClick={() => setAuthMode("forgot-password")}
                                                    className="text-xs uppercase font-black text-orange-700 px-1 py-3 -my-3 hover:underline"
                                                >
                                                    ¿La olvidaste?
                                                </button>
                                            )}
                                        </div>
                                        <div className="relative">
                                            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-300" />
                                            <Input
                                                type={isPasswordVisible ? "text" : "password"}
                                                id="auth-password" name="password" autoComplete={authMode === "login" ? "current-password" : "new-password"}
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                placeholder="Tu contraseña"
                                                className="h-14 pl-11 pr-12 bg-zinc-50 border-transparent focus:bg-white focus:ring-2 focus:ring-orange-500/10 transition-all rounded-2xl font-bold"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setIsPasswordVisible(!isPasswordVisible)}
                                                aria-label={isPasswordVisible ? "Ocultar contraseña" : "Mostrar contraseña"}
                                                aria-pressed={isPasswordVisible}
                                                className="absolute right-1 top-1/2 -translate-y-1/2 h-11 w-11 flex items-center justify-center text-zinc-500 hover:text-zinc-900"
                                            >
                                                {isPasswordVisible ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                            </button>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>

                            {/* Confirm password (register only) */}
                            {authMode === "register" && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    className="space-y-2"
                                >
                                    <Label htmlFor="auth-confirm-password" className="text-xs uppercase font-black text-zinc-600 tracking-widest ml-1">Confirmar Contraseña</Label>
                                    <Input
                                        type={isPasswordVisible ? "text" : "password"}
                                        id="auth-confirm-password" name="confirm-password" autoComplete="new-password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        placeholder="Repite tu contraseña"
                                        className="h-14 bg-zinc-50 border-transparent focus:bg-white focus:ring-2 focus:ring-orange-500/10 transition-all rounded-2xl font-bold"
                                    />
                                    <p className="text-[11px] text-zinc-400 font-medium ml-1">{PASSWORD_RULES_TEXT}</p>
                                </motion.div>
                            )}

                            {/* Submit */}
                            <Button
                                disabled={isLoading}
                                className="w-full h-16 rounded-[1.5rem] bg-orange-500 hover:bg-orange-600 text-white font-black text-base uppercase tracking-widest shadow-xl shadow-orange-500/20 active:scale-[0.98] transition-all group"
                            >
                                {isLoading ? (
                                    <span className="flex items-center gap-2">
                                        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1 }} className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full" />
                                        Procesando...
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-2">
                                        {authMode === "login" && "Ingresar"}
                                        {authMode === "register" && "Unirme ahora"}
                                        {authMode === "magic-link" && "Enviar Enlace"}
                                        {authMode === "forgot-password" && "Enviar Enlace"}
                                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                                    </span>
                                )}
                            </Button>
                        </form>

                        {/* Google + secondary options (login only) */}
                        {googleSection?.placement === "bottom" && (
                            <div className="mt-8 space-y-4">
                                {googleButton}

                                <div className="relative">
                                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-zinc-100" /></div>
                                    <div className="relative flex justify-center text-xs uppercase font-black text-zinc-500 tracking-widest">
                                        <span className="bg-white px-4">{googleSection?.dividerLabel}</span>
                                    </div>
                                </div>

                                <div className="rounded-3xl bg-orange-50 border border-orange-100 p-4 space-y-3">
                                    <p className="text-center text-xs font-black text-zinc-700 uppercase tracking-wider">
                                        ¿Primera vez en Almuerzo.cl?
                                    </p>
                                    <Button
                                        type="button"
                                        onClick={() => setAuthMode("register")}
                                        className="w-full h-14 rounded-2xl bg-white border-2 border-zinc-900 hover:bg-zinc-100 text-zinc-900 font-black text-sm uppercase tracking-widest active:scale-[0.98] transition-all"
                                    >
                                        <UserPlus className="w-5 h-5 mr-2" />
                                        Crear mi cuenta gratis
                                    </Button>
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => setAuthMode("magic-link")}
                                    className="w-full h-12 rounded-2xl font-bold text-zinc-500 hover:text-orange-600 hover:bg-orange-50"
                                >
                                    <Sparkles className="w-4 h-4 mr-2" />
                                    Entrar sin clave
                                </Button>
                            </div>
                        )}

                        <p className="text-center text-xs font-bold text-zinc-600 uppercase tracking-wider mt-10 max-w-[260px] mx-auto leading-relaxed">
                            Al continuar, aceptas la <a href="/privacidad" target="_blank" className="text-zinc-800 underline underline-offset-2 hover:text-orange-700 inline-block py-2">Política de Privacidad</a> de Almuerzo.cl
                        </p>
                    </>
                )}
            </motion.div>
        </div>
    );
}
