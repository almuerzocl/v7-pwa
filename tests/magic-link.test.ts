import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashKey, RESET_LIMITS, DEFAULT_BASE_URL } from '@/lib/server/password-reset';
import { requestMagicLink, safeNext } from '@/lib/server/magic-link';

// Cliente de servicio falso: tabla de límites en memoria, perfiles y generateLink configurables.
function fakeAdmin(opts: { generateError?: any; link?: string | null; vtype?: string; countError?: boolean; counts?: { email?: number; ip?: number } } = {}) {
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
                : { data: { properties: { hashed_token: opts.link === undefined ? 'abc123' : opts.link, verification_type: opts.vtype ?? 'magiclink' } }, error: null };
        } } },
    };
    return { admin, inserts, calls };
}

const sendOk = () => vi.fn().mockResolvedValue({ success: true });
const input = { email: 'Chef@Local.cl ', ip: '200.1.2.3' };

describe('requestMagicLink', () => {
    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

    it('genera el enlace de magiclink (sin redirectTo) y envía un correo con NUESTRO enlace a /auth/ingresar', async () => {
        const f = fakeAdmin(); const send = sendOk();
        expect(await requestMagicLink({ ...input, next: '/orders' }, { admin: f.admin, sendEmail: send })).toBe('sent');
        expect(f.calls.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'chef@local.cl' });
        const mail = send.mock.calls[0][0];
        const expected = `${DEFAULT_BASE_URL}/auth/ingresar?token_hash=abc123&type=magiclink&next=%2Forders`;
        expect(mail.to).toBe('chef@local.cl');
        expect(mail.text).toContain(expected);
        expect(mail.html).toContain(expected.replace(/&/g, '&amp;'));
        expect(mail.text).not.toContain('supabase.co');
    });

    it('un correo nuevo vuelve como signup y se conserva ese tipo', async () => {
        const send = sendOk();
        await requestMagicLink(input, { admin: fakeAdmin({ vtype: 'signup' }).admin, sendEmail: send });
        expect(send.mock.calls[0][0].text).toContain('&type=signup&');
    });

    it('registra con kind magic_link (no mezcla cupos con la recuperación) y con HASH', async () => {
        const f = fakeAdmin();
        await requestMagicLink(input, { admin: f.admin, sendEmail: sendOk() });
        expect(f.inserts).toEqual([
            { kind: 'magic_link', key_type: 'email', key_hash: hashKey('chef@local.cl') },
            { kind: 'magic_link', key_type: 'ip', key_hash: hashKey('200.1.2.3') },
        ]);
    });

    it.each([
        ['por correo', { email: RESET_LIMITS.perEmail }],
        ['por IP', { ip: RESET_LIMITS.perIp }],
    ])('límite %s: rechaza y no envía', async (_n, counts) => {
        const f = fakeAdmin({ counts }); const send = sendOk();
        expect(await requestMagicLink(input, { admin: f.admin, sendEmail: send })).toBe('throttled');
        expect(send).not.toHaveBeenCalled();
        expect(f.calls.generateLink).not.toHaveBeenCalled();
    });

    it('si no se pueden medir los límites falla CERRADO', async () => {
        const send = sendOk();
        expect(await requestMagicLink(input, { admin: fakeAdmin({ countError: true }).admin, sendEmail: send })).toBe('ignored');
        expect(send).not.toHaveBeenCalled();
    });

    it('correo inválido, Auth sin enlace o Resend caído: no revienta', async () => {
        expect(await requestMagicLink({ email: 'no-es-correo', ip: '1.1.1.1' }, { admin: fakeAdmin().admin, sendEmail: sendOk() })).toBe('ignored');
        expect(await requestMagicLink(input, { admin: fakeAdmin({ generateError: { message: 'x' } }).admin, sendEmail: sendOk() })).toBe('ignored');
        expect(await requestMagicLink(input, { admin: fakeAdmin().admin, sendEmail: vi.fn().mockResolvedValue({ success: false, error: 'caído' }) })).toBe('ignored');
    });

    it('el next del correo siempre es una ruta interna', async () => {
        const send = sendOk();
        await requestMagicLink({ ...input, next: 'https://evil.example/x' }, { admin: fakeAdmin().admin, sendEmail: send });
        expect(send.mock.calls[0][0].text).toContain('next=%2F');
        expect(send.mock.calls[0][0].text).not.toContain('evil');
    });
});

describe('safeNext', () => {
    it.each([
        ['/orders', '/orders'], ['/reservations?x=1', '/reservations?x=1'], [undefined, '/'], [42, '/'], ['', '/'],
        ['//evil.example', '/'], ['https://evil.example', '/'], ['javascript:alert(1)', '/'], ['/\\evil.example', '/'],
        ['/login', '/'], ['/auth/callback', '/'], ['/a\nb', '/'], ['/' + 'a'.repeat(600), '/'],
    ])('%j -> %j', (raw, out) => { expect(safeNext(raw)).toBe(out); });
});
