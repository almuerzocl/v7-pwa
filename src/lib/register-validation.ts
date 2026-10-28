import { validatePassword, PASSWORD_RULES_TEXT } from '@/lib/password-policy';

export { PASSWORD_RULES_TEXT };

export type RegisterInput = {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    confirmPassword: string;
};

export type RegisterCheck = { ok: true } | { ok: false; error: string };

// Mismas reglas de contraseña que cambiar/restablecer (password-policy): Supabase solo exige 6 caracteres.
export function validateRegister(input: RegisterInput): RegisterCheck {
    if (!input.email.trim() || !input.password.trim() || !input.firstName.trim() || !input.lastName.trim()) {
        return { ok: false, error: 'Por favor, completa todos los campos' };
    }
    if (input.password !== input.confirmPassword) {
        return { ok: false, error: 'Las contraseñas no coinciden' };
    }
    const policy = validatePassword(input.password);
    if (!policy.ok) return { ok: false, error: policy.error };
    return { ok: true };
}
