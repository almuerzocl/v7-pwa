import { createClient } from './server';

/**
 * Verifies the current authenticated user matches the provided userId.
 * Returns the authenticated user or a descriptive error.
 */
export async function verifyUser(userId: string): Promise<{ authorized: true; userId: string } | { authorized: false; error: string }> {
    try {
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();

        if (error) {
            return { authorized: false, error: 'Tu sesión expiró. Por favor, recarga la página e inicia sesión nuevamente.' };
        }

        if (!user) {
            return { authorized: false, error: 'No has iniciado sesión. Por favor, inicia sesión para continuar.' };
        }

        if (user.id !== userId) {
            return { authorized: false, error: 'No tienes permiso para realizar esta acción.' };
        }

        return { authorized: true, userId: user.id };
    } catch {
        return { authorized: false, error: 'Error de conexión. Verifica tu internet y recarga la página.' };
    }
}
