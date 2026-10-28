import { describe, it, expect } from 'vitest';
import { withShareFooterHtml, withShareFooterText, WHATSAPP_SHARE_URL } from '@/lib/server/share-footer';

describe('bloque «compartir por WhatsApp» de los correos', () => {
    it('el enlace abre WhatsApp con la página https://almuerzo.cl', () => {
        expect(WHATSAPP_SHARE_URL.startsWith('https://wa.me/?text=')).toBe(true);
        expect(decodeURIComponent(WHATSAPP_SHARE_URL)).toContain('https://almuerzo.cl');
    });
    it('se inserta antes de </body> y una sola vez', () => {
        const once = withShareFooterHtml('<html><body><p>Hola</p></body></html>');
        expect(once).toMatch(/Compártelo con tus amigos[\s\S]*<\/body>/);
        expect(withShareFooterHtml(once)).toBe(once);
    });
    it('sin </body> se agrega al final', () => {
        expect(withShareFooterHtml('<p>x</p>').endsWith('</table>')).toBe(true);
    });
    it('el texto plano también lleva el enlace, una sola vez', () => {
        const t = withShareFooterText('Hola');
        expect(t).toContain(WHATSAPP_SHARE_URL);
        expect(withShareFooterText(t)).toBe(t);
    });
});
