import { PWA_URL } from '@/lib/config';
import { sendEmail } from '@/lib/server/email';
import { MIN_SECRET_LENGTH, buildSurveyUrl, signSurveyToken } from '@/lib/server/survey-token';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { WELCOME_SUBJECT, buildWelcomeEmailHtml, buildWelcomeEmailText } from '@/lib/server/welcome-email';

/**
 * Bienvenida a comensales nuevos con enlace personal a la encuesta (migración 042). Mismo diseño que las confirmaciones de reserva:
 * reclamo atómico con claim_welcome_emails(), tope de 5 intentos, marca de envío en welcome_emails.
 *
 * Apagado por defecto: solo envía con WELCOME_EMAILS_ENABLED=true Y un IDENTITY_SECRET válido. Sin eso no reclama nada.
 * El estado guardado no incluye el enlace ni el token; los errores tampoco.
 */

export interface WelcomeConfig {
    identitySecret: string;
    surveyBaseUrl: string;
    renewUrl: string;
    validityDays: number;
}

export const DEFAULT_SURVEY_BASE_URL = 'https://tuopinion.almuerzo.cl';
export const DEFAULT_VALIDITY_DAYS = 30;
export const MAX_WELCOME_ATTEMPTS = 5;

export function readValidityDays(raw: string | undefined): number {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(n) && n >= 1 && n <= 90 ? n : DEFAULT_VALIDITY_DAYS;
}

/** Configuración de producción desde el entorno; null = envíos apagados o mal configurados. */
export function readWelcomeConfig(env: Record<string, string | undefined> = process.env): WelcomeConfig | null {
    if (env.WELCOME_EMAILS_ENABLED !== 'true') return null;
    const identitySecret = env.IDENTITY_SECRET ?? '';
    if (identitySecret.length < MIN_SECRET_LENGTH) return null;
    const surveyBaseUrl = (env.SURVEY_BASE_URL || DEFAULT_SURVEY_BASE_URL).trim().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(surveyBaseUrl)) return null;
    return {
        identitySecret,
        surveyBaseUrl,
        renewUrl: `${PWA_URL.replace(/\/+$/, '')}/encuesta`,
        validityDays: readValidityDays(env.WELCOME_SURVEY_TOKEN_DAYS),
    };
}

export interface WelcomeDeps {
    admin: ReturnType<typeof getSupabaseAdmin>;
    send: (p: { to: string; subject: string; text: string; html: string; rateLimitKey?: string }) => Promise<{ success: boolean; error?: string }>;
    now: () => Date;
    config: WelcomeConfig | null;
}

export interface WelcomeSummary {
    claimed: number;
    completed: number;
    emailsSent: number;
    failed: number;
    skipped: number;
    disabled?: boolean;
}

function defaultDeps(): WelcomeDeps {
    return { admin: getSupabaseAdmin(), send: (p) => sendEmail(p), now: () => new Date(), config: readWelcomeConfig() };
}

type Row = { user_id: string; email: string | null; first_name: string | null; attempts: number };

async function logError(admin: WelcomeDeps['admin'], message: string, metadata: Record<string, unknown>) {
    try {
        await admin.from('error_logs').insert({ app: 'pwa', source: 'welcome-email', severity: 'error', message, metadata });
    } catch { /* no bloqueante */ }
}

export async function processWelcomeEmails(
    opts: { userId?: string; limit?: number } = {},
    deps: WelcomeDeps = defaultDeps(),
): Promise<WelcomeSummary> {
    const { admin, send, now, config } = deps;
    const summary: WelcomeSummary = { claimed: 0, completed: 0, emailsSent: 0, failed: 0, skipped: 0 };
    if (!config) return { ...summary, disabled: true };

    const { data: claimed, error: claimError } = await admin.rpc('claim_welcome_emails', {
        p_limit: opts.limit ?? 20,
        p_user: opts.userId ?? null,
    });
    if (claimError) {
        await logError(admin, `No se pudo reclamar bienvenidas: ${claimError.message}`, {});
        throw new Error(claimError.message);
    }

    for (const row of (claimed ?? []) as Row[]) {
        summary.claimed++;
        const release = (lastError: string | null) =>
            admin.from('welcome_emails').update({ claimed_at: null, last_error: lastError }).eq('user_id', row.user_id);
        try {
            const to = (row.email ?? '').trim();
            if (!to) {
                // Sin correo no hay a quién escribir: se cierra para no reintentar.
                await admin.from('welcome_emails').update({ sent_at: now().toISOString(), claimed_at: null, last_error: 'sin correo' }).eq('user_id', row.user_id);
                summary.skipped++;
                continue;
            }
            const token = signSurveyToken(to, config.identitySecret, config.validityDays, now().getTime());
            const input = {
                firstName: row.first_name,
                surveyUrl: buildSurveyUrl(config.surveyBaseUrl, token),
                renewUrl: config.renewUrl,
                validityDays: config.validityDays,
            };
            const res = await send({
                to,
                subject: WELCOME_SUBJECT,
                text: buildWelcomeEmailText(input),
                html: buildWelcomeEmailHtml(input),
                rateLimitKey: row.user_id,
            });
            if (res.success) {
                await admin.from('welcome_emails').update({ sent_at: now().toISOString(), claimed_at: null, last_error: null }).eq('user_id', row.user_id);
                summary.completed++;
                summary.emailsSent++;
            } else {
                const reason = String(res.error ?? 'error desconocido').slice(0, 200);
                await release(reason);
                summary.failed++;
                await logError(
                    admin,
                    `Bienvenida no enviada (intento ${row.attempts}/${MAX_WELCOME_ATTEMPTS})${row.attempts >= MAX_WELCOME_ATTEMPTS ? ': SE ABANDONA' : ''}: ${reason}`,
                    { user_id: row.user_id, attempt: row.attempts, gave_up: row.attempts >= MAX_WELCOME_ATTEMPTS },
                );
            }
        } catch (err: any) {
            summary.failed++;
            const reason = String(err?.message ?? err).slice(0, 200);
            await release(reason);
            await logError(admin, `Falló la bienvenida: ${reason}`, { user_id: row.user_id, attempt: row.attempts });
        }
    }
    return summary;
}
