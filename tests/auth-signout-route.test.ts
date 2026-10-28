import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const signOut = vi.fn();
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { signOut } }),
}));

import { GET, POST } from '@/app/auth/signout/route';

// Host interno del contenedor de Cloud Run (HOSTNAME=0.0.0.0): request.url NO es la dirección pública.
const request = (method: 'GET' | 'POST') =>
    new NextRequest('https://0.0.0.0:8080/auth/signout', { method });

describe('/auth/signout', () => {
    beforeEach(() => { signOut.mockReset(); });

    it.each([['GET', GET], ['POST', POST]] as const)(
        '%s cierra sesión y redirige a /login con ruta RELATIVA (nunca al host interno 0.0.0.0:8080)',
        async (method, handler) => {
            signOut.mockResolvedValue({ error: null });

            const res = await handler(request(method));

            expect(signOut).toHaveBeenCalledTimes(1);
            // Solo este dispositivo: 'global' (por defecto) cerraba la sesión del usuario en TODOS sus dispositivos.
            expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
            expect(res.status).toBe(303);
            expect(res.headers.get('location')).toBe('/login');
            expect(res.headers.get('location')).not.toContain('0.0.0.0');
            expect(res.headers.get('cache-control')).toBe('no-store');
        },
    );

    it('si signOut() falla igual redirige a /login', async () => {
        signOut.mockRejectedValue(new Error('auth caído'));
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = await POST(request('POST'));

        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/login');
        spy.mockRestore();
    });
});
