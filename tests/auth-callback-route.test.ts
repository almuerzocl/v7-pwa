import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exchangeCodeForSession, getUser, single, upsert } = vi.hoisted(() => ({
    exchangeCodeForSession: vi.fn(), getUser: vi.fn(), single: vi.fn(), upsert: vi.fn(),
}));

vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({
        auth: { exchangeCodeForSession, getUser },
        from: () => ({ select: () => ({ eq: () => ({ single }) }), upsert }),
    }),
}));

import { GET } from '../src/app/auth/callback/route';

const call = (qs: string) => GET(new Request(`https://app2.almuerzo.cl/auth/callback?${qs}`, { headers: { 'x-forwarded-host': 'app2.almuerzo.cl' } }));

describe('GET /auth/callback (retorno de Google)', () => {
    beforeEach(() => {
        exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
        getUser.mockReset().mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.cl', user_metadata: { full_name: 'Ana Pérez' } } } });
        single.mockReset();
        upsert.mockReset().mockResolvedValue({ error: null });
    });

    it('ignora un next externo y vuelve a la raíz', async () => {
        single.mockResolvedValue({ data: { id: 'u1' } });
        for (const next of ['@evil.com', '//evil.com', 'https://evil.com']) {
            const res = await call(`code=c&next=${encodeURIComponent(next)}`);
            expect(res.headers.get('location')).toBe('https://app2.almuerzo.cl/');
        }
    });

    it('respeta un next interno', async () => {
        single.mockResolvedValue({ data: { id: 'u1' } });
        const res = await call(`code=c&next=${encodeURIComponent('/orders')}`);
        expect(res.headers.get('location')).toBe('https://app2.almuerzo.cl/orders');
    });

    it('cuenta existente (mismo id): no crea ni pisa el perfil', async () => {
        single.mockResolvedValue({ data: { id: 'u1' } });
        await call('code=c');
        expect(upsert).not.toHaveBeenCalled();
    });

    it('cuenta nueva: crea el perfil con onboarding pendiente y nombre de Google', async () => {
        single.mockResolvedValue({ data: null });
        await call('code=c');
        expect(upsert).toHaveBeenCalledTimes(1);
        const [row, opts] = upsert.mock.calls[0];
        expect(row).toMatchObject({ id: 'u1', first_name: 'Ana', last_name: 'Pérez', onboarding_completed: false, role: 'USER' });
        expect(opts).toMatchObject({ onConflict: 'id', ignoreDuplicates: true });
    });

    it('el usuario cancela en Google: vuelve a /login con access_denied', async () => {
        const res = await call('error=access_denied&error_code=access_denied');
        expect(res.headers.get('location')).toBe('https://app2.almuerzo.cl/login?error=access_denied');
        expect(exchangeCodeForSession).not.toHaveBeenCalled();
    });
});
