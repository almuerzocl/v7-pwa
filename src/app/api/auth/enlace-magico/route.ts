import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { sendEmail } from '@/lib/server/email';
import { requestMagicLink } from '@/lib/server/magic-link';
import { clientIpFrom } from '@/lib/server/password-reset';

/**
 * POST /api/auth/enlace-magico  { email, next? }
 *
 * Endpoint PÚBLICO (no hay sesión: es el acceso sin contraseña). Por eso:
 *  - `next` (ruta interna a la que volver) se valida en `requestMagicLink` (safeNext);
 *  - la respuesta es SIEMPRE la misma ({ ok: true }) exista o no la cuenta, y falle o no el envío;
 *  - los límites por correo y por IP están en `requestMagicLink` (429 al excederlos; no revelan si la cuenta existe);
 *  - el destino del enlace lo fija el servidor, no el navegador.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
    let email = '';
    let next: unknown;
    try {
        const body = await request.json();
        email = typeof body?.email === 'string' ? body.email : '';
        next = body?.next;
    } catch {
        return NextResponse.json({ ok: false, error: 'Solicitud inválida.' }, { status: 400, headers: NO_STORE });
    }

    const outcome = await requestMagicLink(
        { email, next, ip: clientIpFrom(request.headers) },
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
