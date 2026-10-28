/**
 * Correo de bienvenida a comensales nuevos, con enlace personal a la encuesta (tuopinion.almuerzo.cl).
 * Módulo puro (sin red ni base): solo arma asunto, texto y HTML. El enlace llega ya firmado desde el servidor.
 */

export const HOW_IT_WORKS_URL = 'https://almuerzo.cl/collections/para-comensales';
export const CLAIM = 'Pides, llegas y listo: ¡cero filas!';
export const SIGNATURE = 'almuerzo.cl: solo para Vivaldis';
export const SURVEY_INTRO = 'Tu tiempo de almuerzo es tuyo: queremos ayudarte a disfrutarlo más, trabajando con restaurantes y proveedores para que salir a almorzar sea más fácil. ¿Qué es lo que más te importaría mejorar de tu experiencia al salir a almorzar? Son solo unos minutos.';
export const SURVEY_BUTTON = 'Contar mi experiencia';
export const SHARE_PROMPT = '¿Te gustó almuerzo.cl? ¿Quieres compartirlo con alguien?';
export const SHARE_BUTTON = 'Compartir por WhatsApp';
export const SHARE_MESSAGE = `Te recomiendo almuerzo.cl: ${CLAIM} Mira cómo funciona: ${HOW_IT_WORKS_URL}`;
/** Enlace de WhatsApp con el mensaje ya escrito: la persona elige con quién compartirlo. */
export const SHARE_URL = `https://wa.me/?text=${encodeURIComponent(SHARE_MESSAGE)}`;

export interface WelcomeEmailInput {
    firstName?: string | null;
    surveyUrl: string;
    /** Dónde pedir un enlace nuevo si el del correo venció (requiere sesión). */
    renewUrl: string;
    validityDays: number;
}

const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const greeting = (firstName?: string | null) => {
    const n = (firstName ?? '').trim().slice(0, 60);
    return n ? `Hola ${n},` : 'Hola,';
};

export const WELCOME_SUBJECT = 'Te damos la bienvenida a almuerzo.cl';

export function buildWelcomeEmailText(i: WelcomeEmailInput): string {
    return [
        greeting(i.firstName),
        '',
        'Gracias por sumarte a almuerzo.cl.',
        '',
        'Con tu cuenta puedes:',
        '- Pedir para retirar en el local.',
        '- Reservar mesa.',
        '- Recibir por correo el menú del día.',
        '',
        `Conoce cómo funciona: ${HOW_IT_WORKS_URL}`,
        '',
        SURVEY_INTRO,
        '',
        i.surveyUrl,
        '',
        `Este enlace es personal (no lo compartas) y sirve por ${i.validityDays} días. Si ya venció, ábrelo desde tu cuenta: ${i.renewUrl}`,
        '',
        SHARE_PROMPT,
        `${SHARE_BUTTON}: ${SHARE_URL}`,
        '',
        CLAIM,
        SIGNATURE,
    ].join('\n');
}

export function buildWelcomeEmailHtml(i: WelcomeEmailInput): string {
    const survey = esc(i.surveyUrl);
    const renew = esc(i.renewUrl);
    const how = esc(HOW_IT_WORKS_URL);
    const li = (t: string) =>
        `<tr><td style="padding:6px 0;font-size:15px;color:#333;line-height:1.5;"><span style="color:#f97316;font-weight:900;">&#10003;</span>&nbsp; ${t}</td></tr>`;
    return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(WELCOME_SUBJECT)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#fff;border-radius:24px;overflow:hidden;">
        <tr><td style="background:#f97316;padding:28px 40px;">
          <p style="margin:0;font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px;">almuerzo<span style="opacity:.7">.cl</span></p>
        </td></tr>
        <tr><td style="padding:36px 40px 8px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#111;">${esc(greeting(i.firstName))}</h1>
          <p style="margin:0 0 20px;font-size:15px;color:#555;line-height:1.7;">Gracias por sumarte a almuerzo.cl. Con tu cuenta puedes:</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
            ${li('<strong>Pedir para retirar</strong> en el local.')}
            ${li('<strong>Reservar mesa</strong>.')}
            ${li('<strong>Recibir por correo el menú del día</strong>.')}
          </table>
          <p style="margin:0 0 28px;font-size:14px;color:#555;line-height:1.7;"><a href="${how}" style="color:#f97316;font-weight:700;">Conoce cómo funciona</a></p>
        </td></tr>
        <tr><td style="padding:0 40px;"><div style="border-top:1px solid #eee;"></div></td></tr>
        <tr><td style="padding:28px 40px 8px;">
          <p style="margin:0 0 22px;font-size:15px;color:#333;line-height:1.7;">${esc(SURVEY_INTRO)}</p>
          <a href="${survey}" style="display:inline-block;background:#f97316;color:#fff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 28px;border-radius:12px;">${esc(SURVEY_BUTTON)}</a>
          <p style="margin:18px 0 0;font-size:12px;color:#888;line-height:1.6;">Este enlace es personal, no lo compartas. Sirve por ${i.validityDays} días. Si ya venció, <a href="${renew}" style="color:#888;">ábrelo desde tu cuenta</a>.</p>
        </td></tr>
        <tr><td style="padding:0 40px;"><div style="border-top:1px solid #eee;"></div></td></tr>
        <tr><td style="padding:24px 40px 8px;">
          <p style="margin:0 0 14px;font-size:15px;color:#333;line-height:1.7;">${esc(SHARE_PROMPT)}</p>
          <a href="${esc(SHARE_URL)}" style="display:inline-block;background:#fff;color:#f97316;border:2px solid #f97316;font-weight:700;font-size:15px;text-decoration:none;padding:12px 26px;border-radius:12px;">${esc(SHARE_BUTTON)}</a>
        </td></tr>
        <tr><td style="padding:28px 40px 36px;">
          <p style="margin:0 0 4px;font-size:16px;font-weight:800;color:#111;">${esc(CLAIM)}</p>
          <p style="margin:0;font-size:13px;color:#888;">${esc(SIGNATURE)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
