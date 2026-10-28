/**
 * Política de contraseña del personal del restaurante.
 *
 * Supabase solo exige 6 caracteres (Authentication → Sign In / Providers → Email, "Minimum password length" = 6, sin requisitos de
 * caracteres; "leaked passwords" requiere plan Pro). Esa política vive fuera del código y es débil, así que la aplicamos nosotros EN EL
 * SERVIDOR antes de llamar a Supabase (la pantalla solo la repite para avisar rápido).
 *
 *   - mínimo 8 caracteres (Supabase recomienda 8 o más)
 *   - al menos una letra y un número
 *   - máximo 72 BYTES: bcrypt (el hash de Supabase) ignora lo que pase de 72 bytes, y dos contraseñas largas distintas serían la misma.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_RULES_TEXT = `Mínimo ${PASSWORD_MIN_LENGTH} caracteres, con al menos una letra y un número.`;

export type PasswordCheck = { ok: true } | { ok: false; error: string };

const HAS_LETTER = new RegExp('\\p{L}', 'u');
const HAS_NUMBER = new RegExp('\\p{N}', 'u');

export function validatePassword(password: unknown): PasswordCheck {
    if (typeof password !== 'string') return { ok: false, error: 'La contraseña es obligatoria.' };
    if (password.length < PASSWORD_MIN_LENGTH) {
        return { ok: false, error: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.` };
    }
    if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
        return { ok: false, error: `La contraseña es demasiado larga (máximo ${PASSWORD_MAX_BYTES} bytes).` };
    }
    // RegExp(…, 'u') y no literal: el tsconfig de este repo apunta a < ES6 y rechaza el flag en literales (en ejecución es igual).
    if (!HAS_LETTER.test(password) || !HAS_NUMBER.test(password)) {
        return { ok: false, error: 'La contraseña debe incluir al menos una letra y un número.' };
    }
    return { ok: true };
}
