import { NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/server';
import { validatePassword } from '@/lib/password-policy';
import { RECENT_SESSION_MS } from '@/lib/recent-session';

/**
 * POST /api/auth/cambiar-contrasena  { newPassword, currentPassword? }
 *
 * Cambia la contraseña de la sesión actual. Se hace por servidor (y no con supabase.auth.updateUser en el navegador) para APLICAR la
 * política de contraseña (src/lib/password-policy.ts) donde no se puede saltar: la de Supabase es de solo 6 caracteres.
 *
 * Con `currentPassword` se verifica contra Auth (cambio normal desde "Mi cuenta"). Sin ella solo se acepta si la sesión es RECIENTE
 * (última autenticación < 15 min): es el caso del enlace de recuperación, que acaba de autenticar a la persona por correo. Una sesión
 * vieja (p. ej. un dispositivo ajeno que quedó abierto) no puede cambiar la contraseña sin conocer la actual.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const err = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });

export async function POST(request: Request) {
    let body: any;
    try { body = await request.json(); } catch { return err('Solicitud inválida.', 400); }

    const policy = validatePassword(body?.newPassword);
    if (!policy.ok) return err(policy.error, 400);
    const newPassword = body.newPassword as string;
    const currentPassword = typeof body?.currentPassword === 'string' && body.currentPassword.length > 0 ? body.currentPassword : null;

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return err('Tu sesión expiró. Vuelve a abrir el enlace o inicia sesión.', 401);

    if (currentPassword) {
        // Verificación con un cliente aparte y sin persistencia: no toca la sesión del navegador.
        const verifier = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
            auth: { autoRefreshToken: false, persistSession: false },
        });
        const { error: verifyError } = await verifier.auth.signInWithPassword({ email: user.email ?? '', password: currentPassword });
        if (verifyError) return err('La contraseña actual no es correcta.', 400);
        if (currentPassword === newPassword) return err('La nueva contraseña debe ser distinta de la actual.', 400);
    } else {
        const lastAuth = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : NaN;
        if (!Number.isFinite(lastAuth) || Date.now() - lastAuth > RECENT_SESSION_MS) {
            return err('Por seguridad, ingresa tu contraseña actual para cambiarla.', 403);
        }
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) {
        const msg = /weak|same_password|different from the old/i.test(`${updateError.code ?? ''} ${updateError.message ?? ''}`)
            ? 'Esa contraseña no es válida o es igual a la anterior. Elige otra.'
            : 'No pudimos cambiar la contraseña. Inténtalo de nuevo.';
        console.error('[cambiar-contrasena] updateUser:', updateError.message);
        return err(msg, 400);
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
