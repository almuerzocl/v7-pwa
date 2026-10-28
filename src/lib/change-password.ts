import { validatePassword } from '@/lib/password-policy';

/**
 * Cambio de contraseña desde el navegador: la política se valida aquí para avisar rápido, pero la que cuenta es la del servidor
 * (/api/auth/cambiar-contrasena). `currentPassword` es opcional: sin ella el servidor solo acepta una sesión reciente.
 */
export async function changePassword(input: { newPassword: string; currentPassword?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    const policy = validatePassword(input.newPassword);
    if (!policy.ok) return { ok: false, error: policy.error };
    try {
        const res = await fetch('/api/auth/cambiar-contrasena', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword: input.newPassword, currentPassword: input.currentPassword || undefined }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) return { ok: false, error: data.error || 'No pudimos cambiar la contraseña.' };
        return { ok: true };
    } catch {
        return { ok: false, error: 'No pudimos conectar con el servidor. Inténtalo de nuevo.' };
    }
}
