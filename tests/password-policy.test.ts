import { describe, expect, it } from 'vitest';
import { validatePassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES } from '@/lib/password-policy';

describe('validatePassword', () => {
    it.each(['abcd1234', 'Contraseña9', 'A1b2C3d4', '12345678a', 'ñandú2026'])('acepta %s', (p) => {
        expect(validatePassword(p)).toEqual({ ok: true });
    });

    it('rechaza lo corto (Supabase solo exige 6, aquí 8)', () => {
        const r = validatePassword('abc123');
        expect(r.ok).toBe(false);
        expect((r as any).error).toMatch(new RegExp(`${PASSWORD_MIN_LENGTH} caracteres`));
        expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 2) + '1').ok).toBe(false);   // 7 caracteres
        expect(validatePassword('abcdefg1').ok).toBe(true);   // borde: exactamente 8
    });

    it('exige al menos una letra y un número', () => {
        expect(validatePassword('abcdefghij').ok).toBe(false);
        expect(validatePassword('1234567890').ok).toBe(false);
        expect(validatePassword('!!!!!!!!!!').ok).toBe(false);
    });

    it('rechaza lo que supere los 72 BYTES de bcrypt (no solo 72 caracteres)', () => {
        expect(validatePassword('a1' + 'x'.repeat(PASSWORD_MAX_BYTES - 2)).ok).toBe(true);        // 72 bytes exactos
        expect(validatePassword('a1' + 'x'.repeat(PASSWORD_MAX_BYTES - 1)).ok).toBe(false);       // 73
        expect(validatePassword('a1' + 'ñ'.repeat(40)).ok).toBe(false);                          // 82 bytes en 42 caracteres
    });

    it.each([undefined, null, 12345678, {}, []])('rechaza lo que no es texto: %s', (v) => {
        expect(validatePassword(v).ok).toBe(false);
    });
});
