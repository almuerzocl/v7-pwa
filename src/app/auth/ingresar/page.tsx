"use client";

import { useEffect, useState } from "react";
import { trackPlatformEvent } from "@/lib/platform-events";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/utils/supabase/client";
import { safeNext } from "@/lib/safe-next";

type Status = "confirm" | "verifying" | "invalid";

/**
 * Destino del enlace de acceso del correo: /auth/ingresar?token_hash=…&type=magiclink|signup&next=/ruta.
 * El token NO se gasta al abrir la página (un escáner de correo que hace GET no lo consume): se verifica con verifyOtp cuando la
 * persona pulsa "Ingresar". verifyOtp deja la sesión en cookies (cliente de @supabase/ssr).
 */
export default function IngresarPage() {
    const supabase = createClient();
    const [tokenHash, setTokenHash] = useState<string | null>(null);
    const [type, setType] = useState<"magiclink" | "signup">("magiclink");
    const [next, setNext] = useState("/");
    const [status, setStatus] = useState<Status>("confirm");

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const hash = params.get("token_hash");
        const t = params.get("type");
        if (hash && (t === "magiclink" || t === "signup")) {
            setTokenHash(hash);
            setType(t);
            setNext(safeNext(params.get("next")));
            // El token no se queda en la URL (historial, capturas).
            window.history.replaceState(null, "", window.location.pathname);
        } else {
            setStatus("invalid");
        }
    }, []);

    const verify = async () => {
        if (!tokenHash) return setStatus("invalid");
        setStatus("verifying");
        try {
            const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
            if (error) return setStatus("invalid");
            trackPlatformEvent("login", { props: { source: type === "signup" ? "signup_link" : "magic_link" } });
            window.location.href = next;
        } catch {
            setStatus("invalid");
        }
    };

    return (
        <div className="min-h-[100dvh] flex items-center justify-center bg-zinc-50 px-4">
            <div className="w-full max-w-md space-y-6">
                <h1 className="text-center text-3xl font-black tracking-tight text-zinc-900">Ingresar</h1>
                <div className="bg-white border border-zinc-100 shadow-sm p-8 rounded-[2rem] space-y-6">
                    {status !== "invalid" ? (
                        <div className="space-y-5 text-center">
                            <p className="text-sm text-zinc-500">Pulsa el botón para ingresar a tu cuenta de Almuerzo.cl.</p>
                            <Button type="button" onClick={verify} disabled={status === "verifying" || !tokenHash} className="w-full h-14 text-base font-black rounded-2xl">
                                {status === "verifying" ? <Loader2 className="w-5 h-5 animate-spin" /> : "Ingresar"}
                            </Button>
                        </div>
                    ) : (
                        <div className="space-y-4 text-center" role="alert">
                            <h2 className="text-xl font-black text-zinc-900">El enlace no es válido</h2>
                            <p className="text-sm text-zinc-500">El enlace venció, ya se usó o no corresponde a esta cuenta. Pide uno nuevo.</p>
                            <Link href="/login" className="inline-block text-sm font-bold text-orange-600 underline underline-offset-4">Ir a iniciar sesión y pedir uno nuevo</Link>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
