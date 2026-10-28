/**
 * Bloque «¿Te gusta Almuerzo.cl? Compártelo con tus amigos» que se agrega a TODO correo saliente.
 * Archivo IDÉNTICO en pwa, admin-dashboard y restaurant-dashboard (verificar con `cmp`); cada repo lo aplica
 * dentro de su único `sendEmail`, así ningún correo nuevo puede salir sin el botón.
 */

export const SHARE_URL = 'https://almuerzo.cl';
const SHARE_MESSAGE = `¡Mira Almuerzo.cl! Reserva y pide tu almuerzo fácil: ${SHARE_URL}`;
export const WHATSAPP_SHARE_URL = `https://wa.me/?text=${encodeURIComponent(SHARE_MESSAGE)}`;
export const SHARE_LABEL = '¿Te gusta Almuerzo.cl? Compártelo con tus amigos';

const MARKER = 'data-almuerzo-share="whatsapp"';

export function shareFooterHtml(): string {
    return (
        `<table role="presentation" ${MARKER} width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:24px auto 0;border-top:1px solid #e2e8f0">` +
        `<tr><td align="center" style="padding:20px 24px 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#475569">${SHARE_LABEL}</td></tr>` +
        `<tr><td align="center" style="padding:0 24px 24px">` +
        `<a href="${WHATSAPP_SHARE_URL}" target="_blank" rel="noopener" style="display:inline-block;background:#0f7b63;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:8px">Compartir por WhatsApp</a>` +
        `</td></tr></table>`
    );
}

export function shareFooterText(): string {
    return `\n\n${SHARE_LABEL}: ${WHATSAPP_SHARE_URL}`;
}

/** Inserta el bloque antes de </body> (o al final) una sola vez. */
export function withShareFooterHtml(html: string): string {
    if (html.includes(MARKER)) return html;
    const block = shareFooterHtml();
    const idx = html.search(/<\/body\s*>/i);
    return idx === -1 ? html + block : html.slice(0, idx) + block + html.slice(idx);
}

export function withShareFooterText(text: string): string {
    return text.includes(WHATSAPP_SHARE_URL) ? text : text + shareFooterText();
}
