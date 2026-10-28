import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let user: { id: string } | null = { id: 'u1' };
let rpcResult: { data: any; error: any } = { data: null, error: null };
const rpcCalls: Array<[string, any]> = [];
const adminOptions: any[] = [];

vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}));
vi.mock('@supabase/supabase-js', () => ({
    createClient: (_u: string, _k: string, options: any) => {
        adminOptions.push(options);
        return { rpc: async (name: string, args: any) => { rpcCalls.push([name, args]); return rpcResult; } };
    },
}));

const RID = '11111111-1111-4111-8111-111111111111';
const url = (qs: Record<string, string>) => new NextRequest('http://x/api/availability?' + new URLSearchParams(qs));
const good = { restaurantId: RID, time: '2026-10-05T16:00:00.000Z', partySize: '4' };

beforeEach(() => {
    user = { id: 'u1' };
    rpcResult = { data: null, error: null };
    rpcCalls.length = 0;
    adminOptions.length = 0;
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
});

describe('GET /api/availability', () => {
    it('rechaza sin sesión y no ejecuta la función', async () => {
        user = null;
        const { GET }: any = await import('@/app/api/availability/route');
        expect((await GET(url(good))).status).toBe(401);
        expect(rpcCalls).toHaveLength(0);
    });

    it('rechaza parámetros inválidos', async () => {
        const { GET }: any = await import('@/app/api/availability/route');
        for (const bad of [{ ...good, restaurantId: 'x' }, { ...good, time: 'nope' }, { ...good, partySize: '0' }, { ...good, partySize: '2.5' }]) {
            expect((await GET(url(bad))).status).toBe(400);
        }
        expect(rpcCalls).toHaveLength(0);
    });

    it('devuelve cupo con el mismo formato que la función (arreglo de una fila)', async () => {
        rpcResult = { data: [{ is_available: false, remaining_seats: 1 }], error: null };
        const { GET }: any = await import('@/app/api/availability/route');
        const body = await (await GET(url(good))).json();
        expect(body).toEqual({ ok: true, isAvailable: false, remainingSeats: 1 });
        expect(rpcCalls[0]).toEqual(['check_restaurant_availability', { p_restaurant_id: RID, p_selected_time: good.time, p_party_size: 4 }]);
    });

    it('ante error de la base responde ok:false (el navegador deja pasar)', async () => {
        rpcResult = { data: null, error: { message: 'boom' } };
        const { GET }: any = await import('@/app/api/availability/route');
        const res = await GET(url(good));
        expect(res.status).toBe(502);
        expect((await res.json()).ok).toBe(false);
    });

    it('sin caché de datos de Next', async () => {
        const route: any = await import('@/app/api/availability/route');
        expect(route.fetchCache).toBe('force-no-store');
        await route.GET(url(good));
        expect(typeof adminOptions[0].global.fetch).toBe('function');
    });
});

describe('GET /api/restaurants-with-discounts', () => {
    it('rechaza sin sesión', async () => {
        user = null;
        const { GET }: any = await import('@/app/api/restaurants-with-discounts/route');
        expect((await GET()).status).toBe(401);
        expect(rpcCalls).toHaveLength(0);
    });

    it('mapea restaurantes y logos', async () => {
        rpcResult = { data: [{ restaurant_id: RID, institution_logos: ['a.png'] }, { restaurant_id: 'r2', institution_logos: null }], error: null };
        const { GET }: any = await import('@/app/api/restaurants-with-discounts/route');
        const body = await (await GET()).json();
        expect(body).toEqual({ ok: true, restaurants: [{ restaurantId: RID, logos: ['a.png'] }, { restaurantId: 'r2', logos: [] }] });
        expect(rpcCalls[0][0]).toBe('get_restaurants_with_discounts_today');
    });

    it('ante error responde 200 con ok:false (listado sin logos)', async () => {
        rpcResult = { data: null, error: { message: 'boom' } };
        const { GET }: any = await import('@/app/api/restaurants-with-discounts/route');
        const res = await GET();
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(false);
    });
});
