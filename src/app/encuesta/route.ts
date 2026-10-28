import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { DEFAULT_SURVEY_BASE_URL, readValidityDays } from '@/lib/server/welcome-email-job';
import { MIN_SECRET_LENGTH, buildSurveyUrl, signSurveyToken } from '@/lib/server/survey-token';

export const dynamic = 'force-dynamic';

/**
 * GET /encuesta — el enlace del correo de bienvenida venció: desde aquí, con sesión, se emite uno nuevo y se redirige a la encuesta.
 * Sin sesión, el middleware manda a /login y vuelve aquí. El correo del token sale de la sesión (nunca de la URL) y el
 * correo debe estar verificado. Redirección relativa o a la URL base fijada por el servidor (nunca derivada del request).
 */
export async function GET() {
    const secret = process.env.IDENTITY_SECRET ?? '';
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    if (secret.length < MIN_SECRET_LENGTH) {
        return NextResponse.json({ error: 'No disponible por ahora.' }, { status: 503, headers });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new NextResponse(null, { status: 303, headers: { ...headers, Location: '/login?redirect=%2Fencuesta' } });
    if (!user.email || !user.email_confirmed_at) {
        return NextResponse.json({ error: 'Tu correo aún no está verificado.' }, { status: 403, headers });
    }

    const base = (process.env.SURVEY_BASE_URL || DEFAULT_SURVEY_BASE_URL).trim();
    const token = signSurveyToken(user.email, secret, readValidityDays(process.env.WELCOME_SURVEY_TOKEN_DAYS));
    return new NextResponse(null, { status: 303, headers: { ...headers, Location: buildSurveyUrl(base, token) } });
}
