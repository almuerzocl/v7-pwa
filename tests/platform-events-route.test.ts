import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let user: { id: string } | null = { id: 'u1' };
let rpcResult: { data: any; error: any } = { data: { inserted: 2 }, error: null };
const rpcCalls: Array<[string, any]> = [];

vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}));
vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({ rpc: async (name: string, args: any) => { rpcCalls.push([name, args]); return rpcResult; } }),
}));

const RID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const post = (body: unknown, raw?: string) => new NextRequest('http://x/api/platform-events', { method: 'POST', body: raw ?? JSON.stringify(body) });
const ev = (over: Record<string, unknown> = {}) => ({ type: 'discount_view', sessionId: 'sess-12345678', platform: 'android', step: 'cart', discountId: DID, ...over });

beforeEach(() => {
    user = { id: 'u1' };
    rpcResult = { data: { inserted: 2 }, error: null };
    rpcCalls.length = 0;
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
});

describe('POST /api/platform-events', () => {
    it('sin sesión responde 401 y no escribe', async () => {
        user = null;
        const { POST }: any = await import('@/app/api/platform-events/route');
        expect((await POST(post({ events: [ev()] }))).status).toBe(401);
        expect(rpcCalls).toHaveLength(0);
    });

    it('registra con el usuario de la SESIÓN (nunca uno que mande el navegador) y pasa el lote en snake_case', async () => {
        const { POST }: any = await import('@/app/api/platform-events/route');
        const res = await POST(post({ events: [ev(), ev({ type: 'checkout_submit', step: undefined, refId: RID, props: { kind: 'order', result: 'ok' } })], user_id: 'otro', userId: 'otro' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, inserted: 2 });
        expect(rpcCalls[0][0]).toBe('record_platform_events');
        expect(rpcCalls[0][1].p_user_id).toBe('u1');
        expect(rpcCalls[0][1].p_events[0]).toEqual({ event_type: 'discount_view', session_id: 'sess-12345678', step: 'cart', restaurant_id: null, discount_id: DID, ref_id: null, platform: 'android', standalone: null, props: {} });
        expect(rpcCalls[0][1].p_events[1].props).toEqual({ kind: 'order', result: 'ok' });
        expect(rpcCalls[0][1].p_events[1].ref_id).toBe(RID);
    });

    it('no deja pasar texto libre: las propiedades fuera de la lista blanca se descartan', async () => {
        const { POST }: any = await import('@/app/api/platform-events/route');
        await POST(post({ events: [ev({ type: 'search', props: { count: 4, query: 'pizza cerca de mi casa', email: 'a@b.cl' } })] }));
        expect(rpcCalls[0][1].p_events[0].props).toEqual({ count: 4 });
    });

    it('descarta lo inválido pero conserva los eventos buenos del mismo lote', async () => {
        const { POST }: any = await import('@/app/api/platform-events/route');
        await POST(post({ events: [ev({ type: 'hackeo' }), ev({ sessionId: 'a' }), 'texto', null, ev({ discountId: 'x', step: 'Paso Uno' }), ev()] }));
        const sent = rpcCalls[0][1].p_events;
        expect(sent).toHaveLength(2);
        expect(sent[0].discount_id).toBeNull();
        expect(sent[0].step).toBeNull();
    });

    it('un lote sin nada válido responde ok sin tocar la base', async () => {
        const { POST }: any = await import('@/app/api/platform-events/route');
        const res = await POST(post({ events: [ev({ type: 'hackeo' })] }));
        expect(await res.json()).toEqual({ ok: true, inserted: 0 });
        expect(rpcCalls).toHaveLength(0);
    });

    it('rechaza cuerpo vacío, no JSON o demasiado grande', async () => {
        const { POST }: any = await import('@/app/api/platform-events/route');
        expect((await POST(post({ events: [] }))).status).toBe(400);
        expect((await POST(post(null, 'esto no es json'))).status).toBe(400);
        expect((await POST(post({ nada: 1 }))).status).toBe(400);
        expect((await POST(post(null, JSON.stringify({ events: [ev()], relleno: 'x'.repeat(40_000) })))).status).toBe(413);
        expect(rpcCalls).toHaveLength(0);
    });

    it('corta en 50 eventos por llamada', async () => {
        const { POST }: any = await import('@/app/api/platform-events/route');
        await POST(post({ events: Array.from({ length: 120 }, () => ev()) }));
        expect(rpcCalls[0][1].p_events).toHaveLength(50);
    });

    it('limita las llamadas por usuario (120 por minuto)', async () => {
        user = { id: 'spammer' };
        const { POST }: any = await import('@/app/api/platform-events/route');
        let last = 200;
        for (let i = 0; i < 121; i++) last = (await POST(post({ events: [ev()] }))).status;
        expect(last).toBe(429);
    });

    it('si la base falla responde 502 (el navegador lo ignora)', async () => {
        rpcResult = { data: null, error: { message: 'boom' } };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { POST }: any = await import('@/app/api/platform-events/route');
        expect((await POST(post({ events: [ev()] }))).status).toBe(502);
    });
});
