import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildInviteUrl, buildInviteMessage, shareInvite } from '@/lib/share-invite';

const base = { ticketBaseUrl: 'https://tickets2.almuerzo.cl/', uniqueCode: 'AB12CD34', guestId: 'g-1' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('share-invite', () => {
    it('arma el enlace personal /v/<código>?g=<id> sin barra doble', () => {
        expect(buildInviteUrl(base)).toBe('https://tickets2.almuerzo.cl/v/AB12CD34?g=g-1');
    });
    it('escapa código e id', () => {
        expect(buildInviteUrl({ ...base, uniqueCode: 'a b', guestId: 'x&y' })).toBe('https://tickets2.almuerzo.cl/v/a%20b?g=x%26y');
    });
    it('el mensaje usa el primer nombre, el anfitrión y la hora de Santiago', () => {
        const { text } = buildInviteMessage({ ...base, guestName: 'Ana María Pérez', organizerName: 'Esteban', restaurantName: 'Cri-Olla', dateTime: '2026-11-06T16:30:00Z' });
        expect(text).toContain('Hola Ana!');
        expect(text).toContain('Esteban te invita a Cri-Olla');
        expect(text).toMatch(/13:30/); // 16:30Z = 13:30 en Santiago (UTC-3 en noviembre)
    });
    it('sin datos opcionales el mensaje sigue siendo válido', () => {
        const { text } = buildInviteMessage(base);
        expect(text).toBe('Te invitan. Confirma tu asistencia aquí:');
    });
    it('usa navigator.share si existe', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share });
        expect(await shareInvite(base)).toBe('shared');
        expect(share.mock.calls[0][0].url).toBe('https://tickets2.almuerzo.cl/v/AB12CD34?g=g-1');
    });
    it('si el usuario cierra la hoja no hace nada más', async () => {
        const share = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }));
        const open = vi.fn();
        vi.stubGlobal('navigator', { share });
        vi.stubGlobal('window', { open });
        expect(await shareInvite(base)).toBe('cancelled');
        expect(open).not.toHaveBeenCalled();
    });
    it('sin hoja de compartir abre WhatsApp', async () => {
        const open = vi.fn().mockReturnValue({});
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('window', { open });
        expect(await shareInvite(base)).toBe('whatsapp');
        expect(open.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/\?text=/);
    });
    it('sin hoja ni ventana copia el mensaje', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        vi.stubGlobal('window', { open: vi.fn().mockReturnValue(null) });
        expect(await shareInvite(base)).toBe('copied');
        expect(writeText).toHaveBeenCalled();
    });
});
