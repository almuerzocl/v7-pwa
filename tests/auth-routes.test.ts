import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rutas de contraseña: se simulan el servicio de recuperación y los clientes de Supabase.
const { requestMagicLink, requestPasswordReset, getUser, updateUser, signInWithPassword } = vi.hoisted(() => ({
    requestMagicLink: vi.fn(), requestPasswordReset: vi.fn(), getUser: vi.fn(), updateUser: vi.fn(), signInWithPassword: vi.fn(),
}));

vi.mock('@/lib/server/password-reset', async (orig) => ({ ...(await orig<any>()), requestPasswordReset }));
vi.mock('@/lib/server/magic-link', async (orig) => ({ ...(await orig<any>()), requestMagicLink }));
vi.mock('@/lib/server/supabase-admin', () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock('@/lib/server/email', () => ({ sendEmail: vi.fn() }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser, updateUser } }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { signInWithPassword } }) }));

import { POST as enlaceMagico } from '../src/app/api/auth/enlace-magico/route';
import { POST as recuperar } from '../src/app/api/auth/recuperar/route';
import { POST as cambiar, RECENT_SESSION_MS } from '../src/app/api/auth/cambiar-contrasena/route';

const req = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('POST /api/auth/recuperar', () => {
    beforeEach(() => { requestPasswordReset.mockReset(); });

    it.each(['sent', 'ignored'] as const)('responde SIEMPRE igual (%s): no revela si el correo existe', async (outcome) => {
        requestPasswordReset.mockResolvedValue(outcome);
        const res = await recuperar(req({ email: 'a@b.cl' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('al exceder los límites responde 429 con Retry-After', async () => {
        requestPasswordReset.mockResolvedValue('throttled');
        const res = await recuperar(req({ email: 'a@b.cl' }));
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('3600');
    });

    it('usa la IP de la ÚLTIMA entrada de X-Forwarded-For y el correo recibido', async () => {
        requestPasswordReset.mockResolvedValue('ignored');
        await recuperar(req({ email: 'a@b.cl' }, { 'x-forwarded-for': '6.6.6.6, 200.1.2.3' }));
        expect(requestPasswordReset.mock.calls[0][0]).toEqual({ email: 'a@b.cl', ip: '200.1.2.3' });
    });

    it('un redirectTo en el cuerpo se ignora (ni se pasa al servicio)', async () => {
        requestPasswordReset.mockResolvedValue('ignored');
        await recuperar(req({ email: 'a@b.cl', redirectTo: 'https://phishing.example' }));
        expect(JSON.stringify(requestPasswordReset.mock.calls[0])).not.toContain('phishing');
    });

    it('cuerpo que no es JSON: 400 sin llamar al servicio; correo no-texto: se trata como vacío', async () => {
        expect((await recuperar(req('no-json'))).status).toBe(400);
        expect(requestPasswordReset).not.toHaveBeenCalled();
        requestPasswordReset.mockResolvedValue('ignored');
        expect((await recuperar(req({ email: 123 }))).status).toBe(200);
        expect(requestPasswordReset.mock.calls[0][0].email).toBe('');
    });
});

describe('POST /api/auth/cambiar-contrasena', () => {
    const recent = () => new Date(Date.now() - 60_000).toISOString();
    const stale = () => new Date(Date.now() - RECENT_SESSION_MS - 60_000).toISOString();

    beforeEach(() => {
        getUser.mockReset(); updateUser.mockReset(); signInWithPassword.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'chef@local.cl', last_sign_in_at: recent() } }, error: null });
        updateUser.mockResolvedValue({ error: null });
        signInWithPassword.mockResolvedValue({ error: null });
    });

    it('sin sesión: 401 y no cambia nada', async () => {
        getUser.mockResolvedValue({ data: { user: null }, error: { message: 'x' } });
        expect((await cambiar(req({ newPassword: 'Nueva1234' }))).status).toBe(401);
        expect(updateUser).not.toHaveBeenCalled();
    });

    it('la política se aplica en el SERVIDOR antes de tocar Auth (corta, sin número, larga)', async () => {
        for (const p of ['corta1', 'sinnumeroaqui', 'a1' + 'x'.repeat(80)]) {
            expect((await cambiar(req({ newPassword: p }))).status).toBe(400);
        }
        expect(getUser).not.toHaveBeenCalled();
        expect(updateUser).not.toHaveBeenCalled();
    });

    it('sesión RECIENTE (enlace de recuperación) sin contraseña actual: cambia', async () => {
        expect((await cambiar(req({ newPassword: 'Nueva1234' }))).status).toBe(200);
        expect(updateUser).toHaveBeenCalledWith({ password: 'Nueva1234' });
        expect(signInWithPassword).not.toHaveBeenCalled();
    });

    it('sesión VIEJA sin contraseña actual: 403 (un dispositivo ajeno abierto no puede cambiarla)', async () => {
        getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'chef@local.cl', last_sign_in_at: stale() } }, error: null });
        expect((await cambiar(req({ newPassword: 'Nueva1234' }))).status).toBe(403);
        expect(updateUser).not.toHaveBeenCalled();
    });

    it('sin fecha de último ingreso también se trata como sesión no reciente', async () => {
        getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'chef@local.cl' } }, error: null });
        expect((await cambiar(req({ newPassword: 'Nueva1234' }))).status).toBe(403);
    });

    it('con contraseña actual correcta: cambia aunque la sesión sea vieja', async () => {
        getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'chef@local.cl', last_sign_in_at: stale() } }, error: null });
        expect((await cambiar(req({ newPassword: 'Nueva1234', currentPassword: 'Vieja5678' }))).status).toBe(200);
        expect(signInWithPassword).toHaveBeenCalledWith({ email: 'chef@local.cl', password: 'Vieja5678' });
        expect(updateUser).toHaveBeenCalledTimes(1);
    });

    it('con contraseña actual incorrecta: 400 y no cambia', async () => {
        signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
        expect((await cambiar(req({ newPassword: 'Nueva1234', currentPassword: 'mala' }))).status).toBe(400);
        expect(updateUser).not.toHaveBeenCalled();
    });

    it('la nueva igual a la actual: 400', async () => {
        expect((await cambiar(req({ newPassword: 'Misma1234', currentPassword: 'Misma1234' }))).status).toBe(400);
        expect(updateUser).not.toHaveBeenCalled();
    });

    it('si Auth rechaza el cambio devuelve un mensaje genérico (sin filtrar el texto de Auth)', async () => {
        updateUser.mockResolvedValue({ error: { code: 'unexpected', message: 'detalle interno de Auth' } });
        const res = await cambiar(req({ newPassword: 'Nueva1234' }));
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).not.toContain('detalle interno');
    });

    it('cuerpo que no es JSON: 400', async () => {
        expect((await cambiar(req('no-json'))).status).toBe(400);
    });
});

describe('POST /api/auth/enlace-magico', () => {
    beforeEach(() => { requestMagicLink.mockReset(); });

    it.each(['sent', 'ignored'] as const)('responde SIEMPRE igual (%s)', async (outcome) => {
        requestMagicLink.mockResolvedValue(outcome);
        const res = await enlaceMagico(req({ email: 'a@b.cl' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('al exceder los límites responde 429 con Retry-After', async () => {
        requestMagicLink.mockResolvedValue('throttled');
        const res = await enlaceMagico(req({ email: 'a@b.cl' }));
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('3600');
    });

    it('pasa el correo, el next y la IP de la ÚLTIMA entrada de X-Forwarded-For', async () => {
        requestMagicLink.mockResolvedValue('ignored');
        await enlaceMagico(req({ email: 'a@b.cl', next: '/orders' }, { 'x-forwarded-for': '6.6.6.6, 200.1.2.3' }));
        expect(requestMagicLink.mock.calls[0][0]).toEqual({ email: 'a@b.cl', next: '/orders', ip: '200.1.2.3' });
    });

    it('cuerpo que no es JSON: 400 sin llamar al servicio', async () => {
        expect((await enlaceMagico(req('no-json'))).status).toBe(400);
        expect(requestMagicLink).not.toHaveBeenCalled();
    });
});
