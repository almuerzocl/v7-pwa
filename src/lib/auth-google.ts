// Sin dependencias de React ni de servidor: decide qué muestra el bloque de Google en /login y traduce sus errores.

export type GoogleAuthMode = "login" | "register" | "magic-link" | "forgot-password" | "sent";

export interface GoogleSection {
    /** Dónde va el bloque respecto del formulario: arriba (registro) o debajo (ingreso). */
    placement: "top" | "bottom";
    buttonLabel: string;
    dividerLabel: string;
}

/** `null` = sin botón de Google (enlace mágico, recuperación y pantalla de "revisa tu correo"). */
export function googleSectionFor(mode: GoogleAuthMode): GoogleSection | null {
    if (mode === "login") return { placement: "bottom", buttonLabel: "Continuar con Google", dividerLabel: "Otras opciones" };
    if (mode === "register") return { placement: "top", buttonLabel: "Registrarme con Google", dividerLabel: "o con tu correo" };
    return null;
}

/** Errores que Supabase devuelve a /login (vía /auth/callback) tras el regreso de Google. */
export const GOOGLE_CALLBACK_ERRORS: Record<string, string> = {
    access_denied: "Cancelaste el acceso con Google. Puedes intentarlo de nuevo o usar tu correo.",
    "auth-code-error": "No pudimos completar la autenticación. Intenta de nuevo.",
    incomplete_profile: "Tu perfil está incompleto. Por favor, ingresa de nuevo para sincronizar.",
};

/** Mensaje en español para un error al iniciar el flujo de Google (sin exponer texto técnico en inglés). */
export function googleErrorMessage(err: unknown): string {
    const msg = String((err as { message?: unknown } | null)?.message ?? err ?? "").toLowerCase();
    if (/failed to fetch|networkerror|network request failed|load failed|offline/.test(msg)) {
        return "No hay conexión. Revisa tu internet e inténtalo de nuevo.";
    }
    if (/access_denied|access denied|denied|cancel|popup.*closed|closed.*popup/.test(msg)) {
        return "Cancelaste el acceso con Google. Puedes intentarlo de nuevo o usar tu correo.";
    }
    return "No pudimos continuar con Google. Inténtalo de nuevo.";
}
