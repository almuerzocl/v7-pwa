"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/utils/supabase/client";
import { validatePassword, PASSWORD_RULES_TEXT } from "@/lib/password-policy";
import { changePassword } from "@/lib/change-password";

type Status = "confirm" | "verifying" | "invalid" | "ready" | "saving" | "done";

/**
 * Destino del enlace del correo: /restablecer-contrasena?token_hash=…&type=recovery.
 * El token NO se gasta al abrir la página (un escáner de correo que hace GET no lo consume): se verifica con verifyOtp cuando la
 * persona pulsa "Continuar". verifyOtp deja la sesión en cookies (cliente de @supabase/ssr) y el cambio lo hace el servidor.
 */
export default function RestablecerContrasenaPage() {
    const supabase = createClient();
    const [tokenHash, setTokenHash] = useState<string | null>(null);
    const [status, setStatus] = useState<Status>("confirm");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const hash = params.get("token_hash");
        if (hash && params.get("type") === "recovery") {
            setTokenHash(hash);
            // El token no se queda en la URL (historial, capturas).
            window.history.replaceState(null, "", window.location.pathname);
        } else {
            setStatus("invalid");
        }
    }, []);

    const verify = async () => {
        if (!tokenHash) return setStatus("invalid");
        setError(null);
        setStatus("verifying");
        try {
            const { error: otpError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
            setStatus(otpError ? "invalid" : "ready");
        } catch {
            setStatus("invalid");
        }
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        const policy = validatePassword(password);
        if (!policy.ok) return setError(policy.error);
        if (password !== confirm) return setError("Las contraseñas no coinciden.");

        setStatus("saving");
        const result = await changePassword({ newPassword: password });
        if (!result.ok) {
            setError(result.error);
            setStatus("ready");
            return;
        }
        setStatus("done");
        setTimeout(() => { window.location.href = "/"; }, 1500);
    };

    return (
        <div className="min-h-[100dvh] flex items-center justify-center bg-zinc-50 px-4">
            <div className="w-full max-w-md space-y-6">
                <h1 className="text-center text-3xl font-black tracking-tight text-zinc-900">Nueva contraseña</h1>

                <div className="bg-white border border-zinc-100 shadow-sm p-8 rounded-[2rem] space-y-6">
                    {(status === "confirm" || status === "verifying") && (
                        <div className="space-y-5 text-center">
                            <p className="text-sm text-zinc-500">Pulsa continuar para elegir una nueva contraseña de tu cuenta.</p>
                            <Button type="button" onClick={verify} disabled={status === "verifying" || !tokenHash} className="w-full h-14 text-base font-black rounded-2xl">
                                {status === "verifying" ? <Loader2 className="w-5 h-5 animate-spin" /> : "Continuar"}
                            </Button>
                        </div>
                    )}

                    {status === "invalid" && (
                        <div className="space-y-4 text-center" role="alert">
                            <h2 className="text-xl font-black text-zinc-900">El enlace no es válido</h2>
                            <p className="text-sm text-zinc-500">El enlace venció, ya se usó o no corresponde a esta cuenta. Pide uno nuevo.</p>
                            <Link href="/login" className="inline-block text-sm font-bold text-orange-600 underline underline-offset-4">Ir a iniciar sesión y pedir uno nuevo</Link>
                        </div>
                    )}

                    {(status === "ready" || status === "saving") && (
                        <form onSubmit={submit} className="space-y-5">
                            <p className="text-sm text-zinc-500">{PASSWORD_RULES_TEXT}</p>
                            <div className="space-y-2">
                                <Label htmlFor="np" className="text-xs font-black uppercase tracking-widest text-zinc-400">Nueva contraseña</Label>
                                <Input id="np" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-14 rounded-2xl" />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="np2" className="text-xs font-black uppercase tracking-widest text-zinc-400">Repite la contraseña</Label>
                                <Input id="np2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-14 rounded-2xl" />
                            </div>
                            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
                            <Button type="submit" disabled={status === "saving"} className="w-full h-14 text-base font-black rounded-2xl">
                                {status === "saving" ? <Loader2 className="w-5 h-5 animate-spin" /> : "Guardar contraseña"}
                            </Button>
                        </form>
                    )}

                    {status === "done" && (
                        <div className="space-y-2 text-center" role="status">
                            <h2 className="text-xl font-black text-zinc-900">Contraseña actualizada</h2>
                            <p className="text-sm text-zinc-500">Te llevamos a la aplicación…</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
