import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { sendEmail } from '@/lib/server/email';
import { clientIpFrom, requestPasswordReset } from '@/lib/server/password-reset';

/**
 * POST /api/auth/recuperar  { email }
 *
 * Endpoint PÚBLICO (no hay sesión: la persona olvidó su contraseña). Por eso:
 *  - la respuesta es SIEMPRE la misma ({ ok: true }) exista o no la cuenta, y falle o no el envío;
 *  - los límites por correo y por IP están en `requestPasswordReset` (429 al excederlos; no revelan si la cuenta existe);
 *  - el destino del enlace lo fija el servidor, no el navegador.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
    let email = '';
    try {
        const body = await request.json();
        email = typeof body?.email === 'string' ? body.email : '';
    } catch {
        return NextResponse.json({ ok: false, error: 'Solicitud inválida.' }, { status: 400, headers: NO_STORE });
    }

    const outcome = await requestPasswordReset(
        { email, ip: clientIpFrom(request.headers) },
        { admin: getSupabaseAdmin() as any, sendEmail, baseUrl: process.env.APP_BASE_URL },
    );

    if (outcome === 'throttled') {
        return NextResponse.json(
            { ok: false, error: 'Demasiados intentos. Espera un rato antes de volver a pedir el enlace.' },
            { status: 429, headers: { ...NO_STORE, 'Retry-After': '3600' } },
        );
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
