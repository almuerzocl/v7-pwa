import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';

/**
 * POST /auth/signout
 *
 * Server-side sign-out. Clears the Supabase session cookies in the same
 * response that redirects the user to /login, so there is no window in
 * which the client still holds a valid cookie after "Cerrar Sesión".
 *
 * GET is allowed too as a convenience (e.g. from an anchor link) but the
 * canonical path is a <form method="post"> submission.
 */
async function handle(request: NextRequest) {
    try {
        const supabase = await createClient();
        // scope 'local': cierra SOLO este dispositivo. El valor por defecto, 'global', cerraba la sesión del usuario en TODOS
        // sus dispositivos (decisión del usuario, 2026-10-05).
        await supabase.auth.signOut({ scope: 'local' });
    } catch (err) {
        // Swallow — we still want to send the user to /login either way.
        console.error('[SignOut] supabase.auth.signOut() failed:', err);
    }
    // Redirección RELATIVA a propósito: en Cloud Run el contenedor corre con HOSTNAME=0.0.0.0 y en un route handler
    // `request.url` apunta a https://0.0.0.0:8080/…, una dirección que el navegador no puede abrir (el cierre de sesión
    // terminaba en una página de error). `Location: /login` relativo es válido en HTTP y el navegador lo resuelve
    // contra el dominio público. 303 convierte el POST del formulario en un GET a /login.
    return new NextResponse(null, {
        status: 303,
        headers: { Location: '/login', 'Cache-Control': 'no-store' },
    });
}

export async function POST(request: NextRequest) {
    return handle(request);
}

export async function GET(request: NextRequest) {
    return handle(request);
}
