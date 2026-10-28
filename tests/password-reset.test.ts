import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    requestPasswordReset, hashKey, clientIpFrom, isPlausibleEmail,
    RESET_LIMITS, RESET_WINDOW_MS, RESET_LANDING_PATH, DEFAULT_BASE_URL,
} from '@/lib/server/password-reset';

// Cliente de servicio falso: tabla de límites en memoria, perfiles y generateLink configurables.
function fakeAdmin(opts: { generateError?: any; link?: string | null; countError?: boolean; counts?: { email?: number; ip?: number } } = {}) {
    const inserts: any[] = [];
    const calls = { generateLink: vi.fn() };
    const admin: any = {
        from: (table: string) => {
            if (table === 'auth_email_throttle') {
                const q: any = { _f: {} as any };
                q.select = () => q;
                q.eq = (c: string, v: any) => { q._f[c] = v; return q; };
                q.gte = () => q;
                q.lt = () => Promise.resolve({ error: null });
                q.insert = (r: any[]) => { inserts.push(...r); return Promise.resolve({ error: null }); };
                q.delete = () => q;
                q.then = (res: any, rej: any) => {
                    if (opts.countError) return Promise.resolve({ count: null, error: { message: 'tabla inexistente' } }).then(res, rej);
                    const n = q._f.key_type === 'email' ? (opts.counts?.email ?? 0) : (opts.counts?.ip ?? 0);
                    return Promise.resolve({ count: n, error: null }).then(res, rej);
                };
                return q;
            }
            throw new Error(`tabla inesperada: ${table}`);
        },
        auth: { admin: { generateLink: async (a: any) => {
            calls.generateLink(a);
            return opts.generateError
                ? { data: null, error: opts.generateError }
                : { data: { properties: { hashed_token: opts.link === undefined ? 'abc123' : opts.link } }, error: null };
        } } },
    };
    return { admin, inserts, calls };
}

const sendOk = () => vi.fn().mockResolvedValue({ success: true });
const input = { email: 'Chef@Local.cl ', ip: '200.1.2.3' };

describe('requestPasswordReset', () => {
    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

    it('personal con cuenta: genera el enlace con destino FIJO del servidor y envía el correo', async () => {
        const f = fakeAdmin(); const send = sendOk();
        expect(await requestPasswordReset(input, { admin: f.admin, sendEmail: send })).toBe('sent');
        expect(f.calls.generateLink).toHaveBeenCalledWith({ type: 'recovery', email: 'chef@local.cl' });
        const expected = `${DEFAULT_BASE_URL}${RESET_LANDING_PATH}?token_hash=abc123&type=recovery`;
        const mail = send.mock.calls[0][0];
        expect(mail.to).toBe('chef@local.cl');
        expect(mail.html).toContain(expected);
        expect(mail.text).toContain(expected);
        expect(mail.text).not.toContain('supabase.co');
    });

    it('el destino del enlace sale de la configuración del servidor, nunca de la entrada', async () => {
        const send = sendOk();
        await requestPasswordReset({ ...(input as any), redirectTo: 'https://phishing.example' }, { admin: fakeAdmin().admin, sendEmail: send, baseUrl: 'https://app2.almuerzo.cl/' });
        const text = send.mock.calls[0][0].text;
        expect(text).toContain('https://app2.almuerzo.cl/restablecer-contrasena?token_hash=abc123&type=recovery');
        expect(text).not.toContain('phishing');
    });

    it('el token_hash se codifica en la URL', async () => {
        const send = sendOk();
        await requestPasswordReset(input, { admin: fakeAdmin({ link: 'a&b=c' }).admin, sendEmail: send });
        expect(send.mock.calls[0][0].text).toContain('token_hash=a%26b%3Dc&type=recovery');
    });

    it('registra la solicitud por correo y por IP con HASH (no en claro)', async () => {
        const f = fakeAdmin();
        await requestPasswordReset(input, { admin: f.admin, sendEmail: sendOk() });
        expect(f.inserts).toEqual([
            { kind: 'password_reset', key_type: 'email', key_hash: hashKey('chef@local.cl') },
            { kind: 'password_reset', key_type: 'ip', key_hash: hashKey('200.1.2.3') },
        ]);
        expect(JSON.stringify(f.inserts)).not.toContain('local.cl');
        expect(JSON.stringify(f.inserts)).not.toContain('200.1.2.3');
    });

    it.each([
        ['por correo', { email: RESET_LIMITS.perEmail }],
        ['por IP', { ip: RESET_LIMITS.perIp }],
    ])('límite %s: rechaza, no envía y no registra otra solicitud', async (_n, counts) => {
        const f = fakeAdmin({ counts }); const send = sendOk();
        expect(await requestPasswordReset(input, { admin: f.admin, sendEmail: send })).toBe('throttled');
        expect(send).not.toHaveBeenCalled();
        expect(f.calls.generateLink).not.toHaveBeenCalled();
        expect(f.inserts).toHaveLength(0);
    });

    it('justo por debajo del límite todavía envía', async () => {
        const f = fakeAdmin({ counts: { email: RESET_LIMITS.perEmail - 1, ip: RESET_LIMITS.perIp - 1 } });
        expect(await requestPasswordReset(input, { admin: f.admin, sendEmail: sendOk() })).toBe('sent');
    });

    it('si no se pueden medir los límites falla CERRADO: no envía nada', async () => {
        const f = fakeAdmin({ countError: true }); const send = sendOk();
        expect(await requestPasswordReset(input, { admin: f.admin, sendEmail: send })).toBe('ignored');
        expect(send).not.toHaveBeenCalled();
        expect(f.calls.generateLink).not.toHaveBeenCalled();
    });

    it('correo sin cuenta: Auth no genera el enlace, no se envía nada y SÍ cuenta para los límites', async () => {
        const f = fakeAdmin({ generateError: { message: 'User not found' } }); const send = sendOk();
        expect(await requestPasswordReset(input, { admin: f.admin, sendEmail: send })).toBe('ignored');
        expect(send).not.toHaveBeenCalled();
        expect(f.inserts).toHaveLength(2);
    });

    it('si Auth no genera el enlace o Resend falla, no revienta ni envía nada raro', async () => {
        const a = fakeAdmin({ generateError: { message: 'x' } }); const sendA = sendOk();
        expect(await requestPasswordReset(input, { admin: a.admin, sendEmail: sendA })).toBe('ignored');
        expect(sendA).not.toHaveBeenCalled();
        expect(await requestPasswordReset(input, { admin: fakeAdmin({ link: null }).admin, sendEmail: sendOk() })).toBe('ignored');
        const failing = vi.fn().mockResolvedValue({ success: false, error: 'Resend caído' });
        expect(await requestPasswordReset(input, { admin: fakeAdmin().admin, sendEmail: failing })).toBe('ignored');
    });

    it.each(['', 'sin-arroba', 'a@b', 'x'.repeat(250) + '@l.cl', '  '])('correo no válido (%s): ni toca la base', async (email) => {
        const f = fakeAdmin(); const send = sendOk();
        expect(await requestPasswordReset({ email, ip: '1.1.1.1' }, { admin: f.admin, sendEmail: send })).toBe('ignored');
        expect(f.inserts).toHaveLength(0);
        expect(send).not.toHaveBeenCalled();
    });
});

describe('utilidades', () => {
    it('hashKey normaliza mayúsculas y espacios y no revela el valor', () => {
        expect(hashKey(' Chef@Local.CL ')).toBe(hashKey('chef@local.cl'));
        expect(hashKey('chef@local.cl')).toMatch(/^[0-9a-f]{64}$/);
    });
    it('clientIpFrom usa la ÚLTIMA entrada de X-Forwarded-For (la que añade Cloud Run)', () => {
        const h = (v: string | null) => ({ get: () => v });
        expect(clientIpFrom(h('6.6.6.6, 200.1.2.3'))).toBe('200.1.2.3');
        expect(clientIpFrom(h('200.1.2.3'))).toBe('200.1.2.3');
        expect(clientIpFrom(h(null))).toBe('unknown');
    });
    it('isPlausibleEmail', () => {
        expect(isPlausibleEmail('a@b.cl')).toBe(true);
        expect(isPlausibleEmail('a@b')).toBe(false);
        expect(isPlausibleEmail('a b@c.cl')).toBe(false);
    });
    it('la ventana es de 1 hora', () => { expect(RESET_WINDOW_MS).toBe(3_600_000); });
});
