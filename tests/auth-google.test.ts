import { describe, expect, it } from 'vitest';
import { googleErrorMessage, googleSectionFor } from '../src/lib/auth-google';
import { safeNext } from '../src/lib/safe-next';

describe('googleSectionFor', () => {
    it('login: botón debajo del formulario', () => {
        expect(googleSectionFor('login')).toEqual({ placement: 'bottom', buttonLabel: 'Continuar con Google', dividerLabel: 'Otras opciones' });
    });
    it('register: botón arriba, con su texto y separador', () => {
        expect(googleSectionFor('register')).toEqual({ placement: 'top', buttonLabel: 'Registrarme con Google', dividerLabel: 'o con tu correo' });
    });
    it.each(['magic-link', 'forgot-password', 'sent'] as const)('%s: sin botón de Google', (mode) => {
        expect(googleSectionFor(mode)).toBeNull();
    });
});

describe('googleErrorMessage', () => {
    it('red', () => expect(googleErrorMessage(new Error('Failed to fetch'))).toMatch(/conexión/));
    it('acceso denegado / cierre', () => {
        expect(googleErrorMessage({ message: 'access_denied' })).toMatch(/Cancelaste/);
        expect(googleErrorMessage(new Error('Popup closed by user'))).toMatch(/Cancelaste/);
    });
    it('cualquier otro error: español genérico, sin texto técnico', () => {
        const m = googleErrorMessage(new Error('Unsupported provider: provider is not enabled'));
        expect(m).toBe('No pudimos continuar con Google. Inténtalo de nuevo.');
        expect(googleErrorMessage(undefined)).toBe(m);
    });
});

describe('next del retorno de Google (safeNext)', () => {
    it.each(['https://evil.com', '//evil.com', '@evil.com', '/\\evil.com', 'javascript:alert(1)'])('rechaza %s', (raw) => {
        expect(safeNext(raw)).toBe('/');
    });
    it('acepta rutas internas', () => expect(safeNext('/restaurants/abc?x=1')).toBe('/restaurants/abc?x=1'));
});
