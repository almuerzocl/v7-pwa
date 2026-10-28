// Envío de correo por Resend. Módulo de SERVIDOR sin directiva 'use server': NO es invocable desde el navegador.
// Lo usan los emisores del servidor (reservation-confirmation.ts y order-confirmation.ts).
import { Resend } from 'resend';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { withShareFooterHtml, withShareFooterText } from '@/lib/server/share-footer';

let resendInstance: Resend | null = null;

function getResend() {
    if (!resendInstance && process.env.RESEND_API_KEY) {
        resendInstance = new Resend(process.env.RESEND_API_KEY);
    }
    return resendInstance;
}

const supabaseAdmin = getSupabaseAdmin;

const MAX_EMAILS_PER_DAY = 20;

async function checkEmailRateLimit(key: string): Promise<boolean> {
    try {
        const today = new Date().toISOString().split('T')[0];
        const cacheKey = `email_limit:${key}:${today}`;

        // Count emails sent today by this key using error_logs table as audit trail
        const { count, error } = await supabaseAdmin()
            .from('error_logs')
            .select('*', { count: 'exact', head: true })
            .eq('app', 'pwa')
            .eq('source', 'email-sent')
            .eq('severity', 'info')
            .gte('created_at', `${today}T00:00:00Z`)
            .eq('user_id', key.length === 36 ? key : null); // only track by UUID keys

        if (error) {
            // If rate limit check fails, allow the email (fail open for rate limit)
            console.warn('[Email] Rate limit check failed:', error.message);
            return true;
        }

        return (count || 0) < MAX_EMAILS_PER_DAY;
    } catch {
        return true; // fail open
    }
}

async function logEmailSent(key: string, to: string) {
    try {
        await supabaseAdmin().from('error_logs').insert({
            app: 'pwa',
            source: 'email-sent',
            severity: 'info',
            message: `Email sent to ${to}`,
            user_id: key.length === 36 ? key : null,
        });
    } catch { /* non-blocking */ }
}

export interface EmailPayload {
    to: string;
    subject: string;
    text: string;
    html?: string;
    rateLimitKey?: string;
}

export async function sendEmail({ to, subject, text, html, rateLimitKey }: EmailPayload) {
    try {
        const limitKey = rateLimitKey || to;
        const allowed = await checkEmailRateLimit(limitKey);
        if (!allowed) {
            console.warn(`[Email] Rate limit exceeded for ${limitKey}`);
            return { success: false, error: 'Límite de emails alcanzado. Intenta mañana.' };
        }

        const resend = getResend();
        if (!resend) {
            console.warn('[Email] RESEND_API_KEY not set.');
            return { success: false, error: 'Missing API Key' };
        }

        const fromEmail = process.env.EMAIL_FROM || 'Almuerzo.cl <quiero@almuerzo.cl>';

        let recipient = to;
        let finalSubject = subject;

        if (process.env.FORCE_TO_EMAIL) {
            recipient = process.env.FORCE_TO_EMAIL;
            finalSubject = `[TEST-REDIRECT from ${to}] ${subject}`;
        }

        const { data, error } = await resend.emails.send({
            from: fromEmail,
            to: [recipient],
            subject: finalSubject,
            text: withShareFooterText(text),
            html: withShareFooterHtml(html || `<p>${text.replace(/\n/g, '<br>')}</p>`),
        });

        if (error) {
            console.error('Resend Error:', error);
            return { success: false, error: error.message };
        }

        // Log successful send for rate limiting
        await logEmailSent(limitKey, to);

        return { success: true, data };
    } catch (err: any) {
        console.error('Server Action Error:', err);
        return { success: false, error: err.message };
    }
}
