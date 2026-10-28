import { createHash } from 'node:crypto';

/**
 * Recuperación de contraseña de los CLIENTES de la PWA.
 *
 * Diseño (decisiones del usuario, 2026-10-06): cada repo envía sus propios correos (Resend, `src/lib/server/email.ts`); sin depender del correo de
 * Supabase. Misma lógica que el restaurant-dashboard (tabla `auth_email_throttle` compartida). A diferencia del patrón anterior de la PWA:
 *   - `redirectTo` lo fija el SERVIDOR (nunca llega del navegador): no se puede usar para llevar a un dominio ajeno.
 *   - Hay límites por correo y por IP (tabla `auth_email_throttle`), para que no sirva de relay de correos ni de bombardeo a un buzón.
 *   - La respuesta no revela si el correo existe: si no hay cuenta, Auth no genera el enlace y no se envía nada.
 */
export const RESET_WINDOW_MS = 60 * 60 * 1000;
export const RESET_LIMITS = { perEmail: 3, perIp: 10 } as const;
/** Página pública a la que lleva el enlace del correo (verifica el token_hash con verifyOtp; no usa Redirect URLs de Supabase). */
export const RESET_LANDING_PATH = '/restablecer-contrasena';
export const DEFAULT_BASE_URL = 'https://app2.almuerzo.cl';

export type ResetOutcome = 'sent' | 'ignored' | 'throttled';

/** Hash estable (sha256) para no guardar correos ni IPs en claro en la tabla de límites. */
export function hashKey(value: string): string {
    return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

/** IP real del cliente en Cloud Run: la ÚLTIMA entrada de X-Forwarded-For (verificado en el mapeo directo de dominio). */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
    const xff = headers.get('x-forwarded-for');
    if (!xff) return 'unknown';
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    return parts[parts.length - 1] || 'unknown';
}

export function isPlausibleEmail(email: string): boolean {
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Lo mínimo del cliente de Supabase (service_role) que se usa; facilita simularlo en las pruebas. */
export interface ResetAdminClient {
    from: (table: string) => any;
    auth: { admin: { generateLink: (args: any) => Promise<{ data: any; error: any }> } };
}

export interface ResetDeps {
    admin: ResetAdminClient;
    sendEmail: (p: { to: string; subject: string; text: string; html?: string }) => Promise<{ success: boolean; error?: string }>;
    baseUrl?: string;
    now?: () => number;
}

export type ThrottleKind = 'password_reset' | 'magic_link';

async function countRecent(admin: ResetAdminClient, kind: ThrottleKind, keyType: 'email' | 'ip', keyHash: string, sinceIso: string): Promise<number> {
    const { count, error } = await admin
        .from('auth_email_throttle')
        .select('id', { count: 'exact', head: true })
        .eq('kind', kind)
        .eq('key_type', keyType)
        .eq('key_hash', keyHash)
        .gte('created_at', sinceIso);
    // Si no se puede medir, se rechaza: es preferible no enviar a enviar sin límite.
    if (error) throw error;
    return count ?? 0;
}

/**
 * Límites por correo e IP para los correos de autenticación (recuperación y enlace mágico). Se cuentan TODAS las solicitudes (exista o
 * no la cuenta) para que los límites no delaten qué correos existen. 'unavailable' = no se pudo medir: quien llama NO debe enviar.
 */
export async function applyThrottle(admin: ResetAdminClient, kind: ThrottleKind, email: string, ip: string, now: number): Promise<'ok' | 'throttled' | 'unavailable'> {
    const since = new Date(now - RESET_WINDOW_MS).toISOString();
    const emailKey = hashKey(email);
    const ipKey = hashKey(ip || 'unknown');
    try {
        const [byEmail, byIp] = await Promise.all([
            countRecent(admin, kind, 'email', emailKey, since),
            countRecent(admin, kind, 'ip', ipKey, since),
        ]);
        if (byEmail >= RESET_LIMITS.perEmail || byIp >= RESET_LIMITS.perIp) return 'throttled';
        await admin.from('auth_email_throttle').insert([
            { kind, key_type: 'email', key_hash: emailKey },
            { kind, key_type: 'ip', key_hash: ipKey },
        ]);
        // Limpieza oportunista de lo vencido (sin Scheduler propio): no bloquea ni falla la solicitud.
        void Promise.resolve(admin.from('auth_email_throttle').delete().lt('created_at', new Date(now - 24 * RESET_WINDOW_MS).toISOString())).catch(() => {});
        return 'ok';
    } catch (err: any) {
        console.error(`[${kind}] límites no disponibles:`, err?.message);
        return 'unavailable';
    }
}

export async function requestPasswordReset(input: { email: string; ip: string }, deps: ResetDeps): Promise<ResetOutcome> {
    const email = (input.email ?? '').trim().toLowerCase();
    if (!isPlausibleEmail(email)) return 'ignored';

    const { admin } = deps;
    const now = (deps.now ?? Date.now)();

    // 1) Límites.
    const throttle = await applyThrottle(admin, 'password_reset', email, input.ip, now);
    if (throttle === 'throttled') return 'throttled';
    if (throttle === 'unavailable') return 'ignored';

    // 2) Enlace de recuperación con destino FIJO y propio: lleva el token_hash a NUESTRA página, que lo verifica con verifyOtp
    //    tras un clic del usuario. No se envía el action_link de Supabase: un GET a /verify gasta el token (lo consumen los
    //    escáneres de correo) y devuelve la sesión en el fragmento, que el cliente PKCE de @supabase/ssr no lee.
    const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) {
        console.error('[password-reset] generateLink:', error?.message);
        return 'ignored';
    }
    const link = `${baseUrl}${RESET_LANDING_PATH}?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`;

    // 3) Correo (Resend). Un fallo de envío no se le cuenta al solicitante: la respuesta es siempre la misma.
    const sent = await deps.sendEmail({
        to: email,
        subject: 'Restablece tu contraseña — Almuerzo.cl',
        text: `Para elegir una nueva contraseña de tu cuenta de Almuerzo.cl, abre este enlace:\n\n${link}\n\nSirve una sola vez y vence en 1 hora. Si no lo solicitaste, ignora este correo.`,
        html: buildPasswordResetEmailHtml(link),
    });
    if (!sent.success) {
        console.error('[password-reset] envío fallido:', sent.error);
        return 'ignored';
    }
    return 'sent';
}

function buildPasswordResetEmailHtml(link: string): string {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#fff;border-radius:24px;overflow:hidden;">
        <tr><td style="background:#f97316;padding:28px 40px;">
          <p style="margin:0;font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px;">Almuerzo<span style="opacity:.7">.cl</span></p>
        </td></tr>
        <tr><td style="padding:36px 40px;">
          <h1 style="margin:0 0 12px;font-size:20px;font-weight:800;color:#111;">Restablece tu contraseña</h1>
          <p style="margin:0 0 28px;font-size:14px;color:#555;line-height:1.7;">Recibimos una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el botón para elegir una nueva:</p>
          <a href="${link}" style="display:inline-block;background:#f97316;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:14px 28px;border-radius:12px;">Restablecer contraseña</a>
          <p style="margin:28px 0 0;font-size:12px;color:#888;line-height:1.6;">El enlace sirve una sola vez y vence en 1 hora. Si no solicitaste esto, ignora este correo: tu contraseña no cambia.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
