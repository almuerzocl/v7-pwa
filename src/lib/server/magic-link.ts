import { safeNext } from '@/lib/safe-next';
import { applyThrottle, DEFAULT_BASE_URL, isPlausibleEmail, type ResetDeps, type ResetOutcome } from '@/lib/server/password-reset';

/**
 * Enlace mágico de acceso (login sin contraseña) de la PWA, enviado por nuestro propio correo (Resend).
 *
 * Mismo diseño que la recuperación de contraseña (ver password-reset.ts):
 *   - el destino lo fija el SERVIDOR; el navegador solo aporta el correo y una ruta interna `next` (validada con `safeNext`);
 *   - límites por correo e IP (tabla `auth_email_throttle`, kind 'magic_link');
 *   - el correo lleva /auth/ingresar?token_hash=…, que se verifica con verifyOtp tras un clic (el action_link de Supabase devolvía la
 *     sesión en el fragmento, que el cliente PKCE de @supabase/ssr no lee, y un GET lo gasta);
 *   - la respuesta no revela si la cuenta existía. Como antes, generateLink crea la cuenta si el correo no estaba registrado.
 */
export const MAGIC_LANDING_PATH = '/auth/ingresar';

export { safeNext };

export async function requestMagicLink(input: { email: string; ip: string; next?: unknown }, deps: ResetDeps): Promise<ResetOutcome> {
    const email = (input.email ?? '').trim().toLowerCase();
    if (!isPlausibleEmail(email)) return 'ignored';

    const { admin } = deps;
    const throttle = await applyThrottle(admin, 'magic_link', email, input.ip, (deps.now ?? Date.now)());
    if (throttle === 'throttled') return 'throttled';
    if (throttle === 'unavailable') return 'ignored';

    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) {
        console.error('[magic-link] generateLink:', error?.message);
        return 'ignored';
    }
    // El tipo lo dice Auth (un correo nuevo vuelve como 'signup'): verifyOtp debe usar el mismo.
    const type = data?.properties?.verification_type === 'signup' ? 'signup' : 'magiclink';

    const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const link = `${baseUrl}${MAGIC_LANDING_PATH}?token_hash=${encodeURIComponent(tokenHash)}&type=${type}&next=${encodeURIComponent(safeNext(input.next))}`;

    const sent = await deps.sendEmail({
        to: email,
        subject: 'Tu enlace de acceso — Almuerzo.cl',
        text: `Para ingresar a Almuerzo.cl, abre este enlace:\n\n${link}\n\nSirve una sola vez y vence en 1 hora. Si no lo solicitaste, ignora este correo.`,
        html: buildMagicLinkEmailHtml(link),
    });
    if (!sent.success) {
        console.error('[magic-link] envío fallido:', sent.error);
        return 'ignored';
    }
    return 'sent';
}

function buildMagicLinkEmailHtml(link: string): string {
    const href = link.replace(/&/g, '&amp;');
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
          <h1 style="margin:0 0 12px;font-size:20px;font-weight:800;color:#111;">Tu enlace de acceso</h1>
          <p style="margin:0 0 28px;font-size:14px;color:#555;line-height:1.7;">Haz clic en el botón para ingresar a tu cuenta en Almuerzo.cl sin necesidad de contraseña:</p>
          <a href="${href}" style="display:inline-block;background:#f97316;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:14px 28px;border-radius:12px;">Ingresar a Almuerzo.cl</a>
          <p style="margin:28px 0 0;font-size:12px;color:#888;line-height:1.6;">El enlace sirve una sola vez y vence en 1 hora. Si no lo solicitaste, ignora este correo.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
