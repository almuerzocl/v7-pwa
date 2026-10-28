import { describe, expect, it } from 'vitest';
import { validateRegister } from '../src/lib/register-validation';

const ok = { firstName: 'Ana', lastName: 'Pérez', email: 'ana@saborez.cl', password: 'clave1234', confirmPassword: 'clave1234' };

describe('validateRegister', () => {
    it('acepta datos válidos', () => expect(validateRegister(ok)).toEqual({ ok: true }));
    it.each(['firstName', 'lastName', 'email', 'password'] as const)('rechaza %s vacío o con espacios', (k) => {
        const r = validateRegister({ ...ok, [k]: '   ' });
        expect(r).toEqual({ ok: false, error: 'Por favor, completa todos los campos' });
    });
    it('rechaza claves que no coinciden', () => {
        expect(validateRegister({ ...ok, confirmPassword: 'otra1234' })).toEqual({ ok: false, error: 'Las contraseñas no coinciden' });
    });
    it('rechaza clave de 6 caracteres aunque Supabase la aceptaría', () => {
        const r = validateRegister({ ...ok, password: 'abc123', confirmPassword: 'abc123' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/al menos 8/);
    });
    it('rechaza clave sin número o sin letra', () => {
        expect(validateRegister({ ...ok, password: 'sololetras', confirmPassword: 'sololetras' }).ok).toBe(false);
        expect(validateRegister({ ...ok, password: '123456789', confirmPassword: '123456789' }).ok).toBe(false);
    });
    it('rechaza clave de más de 72 bytes', () => {
        const long = 'a1'.repeat(40);
        expect(validateRegister({ ...ok, password: long, confirmPassword: long }).ok).toBe(false);
    });
    it('los campos vacíos se reportan antes que la política', () => {
        expect(validateRegister({ ...ok, firstName: '', password: 'abc', confirmPassword: 'xyz' })).toEqual({ ok: false, error: 'Por favor, completa todos los campos' });
    });
});
