import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const clientOptions: any[] = [];

vi.mock('@supabase/supabase-js', () => ({
    createClient: (_url: string, _key: string, options: any) => {
        clientOptions.push(options);
        return {
            from: () => ({
                select: () => ({
                    eq: () => ({
                        single: async () => ({
                            data: {
                                name: 'Test',
                                is_active: true,
                                has_takeaway: true,
                                takeaway_settings: {},
                                opening_hours: {},
                            },
                            error: null,
                        }),
                    }),
                }),
            }),
        };
    },
}));

describe('GET /api/takeaway-slots — sin caché de datos de Next', () => {
    beforeEach(() => {
        clientOptions.length = 0;
        vi.resetModules();
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    });

    it('declara fetchCache = force-no-store', async () => {
        const route: any = await import('@/app/api/takeaway-slots/route');
        expect(route.fetchCache).toBe('force-no-store');
    });

    it('el cliente de Supabase hace sus fetch con cache: no-store', async () => {
        const { GET } = await import('@/app/api/takeaway-slots/route');
        await GET(new NextRequest('http://t/api/takeaway-slots?restaurantId=abc'));
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
        await clientOptions[0].global.fetch('https://x.supabase.co/rest/v1/restaurants', { method: 'GET' });
        expect(spy.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
        spy.mockRestore();
    });
});
