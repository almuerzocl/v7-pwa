import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let user: { id: string } | null = { id: 'u1' };
let rpcResult: { data: any; error: any } = { data: { inserted: 2 }, error: null };
const rpcCalls: Array<[string, any]> = [];

vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}));
vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        rpc: async (name: string, args: any) => { rpcCalls.push([name, args]); return rpcResult; },
        from: () => { const q: any = { delete: () => q, eq: () => q, lt: () => q, then: (res: any) => Promise.resolve({ count: 0, error: null }).then(res) }; return q; },
    }),
}));

const RID = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown, raw?: string) => new NextRequest('http://x/api/client-events', { method: 'POST', body: raw ?? JSON.stringify(body) });
const ev = (over: Record<string, unknown> = {}) => ({ restaurantId: RID, type: 'profile_view', surface: 'detail', sessionId: 'sess-12345678', ...over });

beforeEach(() => {
    user = { id: 'u1' };
    rpcResult = { data: { inserted: 2 }, error: null };
    rpcCalls.length = 0;
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
});

describe('POST /api/client-events', () => {
    it('sin sesión responde 401 y no escribe', async () => {
        user = null;
        const { POST }: any = await import('@/app/api/client-events/route');
        expect((await POST(post({ events: [ev()] }))).status).toBe(401);
        expect(rpcCalls).toHaveLength(0);
    });

    it('registra con el usuario de la SESIÓN (nunca uno que mande el navegador) y pasa el lote en snake_case', async () => {
        const { POST }: any = await import('@/app/api/client-events/route');
        const res = await POST(post({ events: [ev(), ev({ type: 'menu_view', surface: 'menu', position: 3 })], user_id: 'otro', userId: 'otro' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, inserted: 2 });
        expect(rpcCalls[0][0]).toBe('record_client_events');
        expect(rpcCalls[0][1].p_user_id).toBe('u1');
        expect(rpcCalls[0][1].p_events).toEqual([
            { restaurant_id: RID, event_type: 'profile_view', surface: 'detail', position: null, session_id: 'sess-12345678' },
            { restaurant_id: RID, event_type: 'menu_view', surface: 'menu', position: 3, session_id: 'sess-12345678' },
        ]);
    });

    it('descarta lo inválido pero conserva los eventos buenos del mismo lote', async () => {
        const { POST }: any = await import('@/app/api/client-events/route');
        await POST(post({ events: [ev({ restaurantId: 'x' }), ev({ type: 'hackeo' }), ev({ sessionId: 'a' }), 'texto', null, ev({ surface: 'inventada', position: -4 }), ev()] }));
        const sent = rpcCalls[0][1].p_events;
        expect(sent).toHaveLength(2);
        expect(sent[0].surface).toBeNull();
        expect(sent[0].position).toBeNull();
    });

    it('un lote sin nada válido responde ok sin tocar la base', async () => {
        const { POST }: any = await import('@/app/api/client-events/route');
        const res = await POST(post({ events: [ev({ type: 'hackeo' })] }));
        expect(await res.json()).toEqual({ ok: true, inserted: 0 });
        expect(rpcCalls).toHaveLength(0);
    });

    it('rechaza cuerpo vacío, no JSON o demasiado grande', async () => {
        const { POST }: any = await import('@/app/api/client-events/route');
        expect((await POST(post({ events: [] }))).status).toBe(400);
        expect((await POST(post(null, 'esto no es json'))).status).toBe(400);
        expect((await POST(post({ nada: 1 }))).status).toBe(400);
        expect((await POST(post(null, JSON.stringify({ events: [ev()], relleno: 'x'.repeat(20_000) })))).status).toBe(413);
        expect(rpcCalls).toHaveLength(0);
    });

    it('corta en 50 eventos por llamada', async () => {
        const { POST }: any = await import('@/app/api/client-events/route');
        await POST(post({ events: Array.from({ length: 120 }, () => ev()) }));
        expect(rpcCalls[0][1].p_events).toHaveLength(50);
    });

    it('limita las llamadas por usuario (60 por minuto)', async () => {
        user = { id: 'spammer' };
        const { POST }: any = await import('@/app/api/client-events/route');
        let last = 200;
        for (let i = 0; i < 61; i++) last = (await POST(post({ events: [ev()] }))).status;
        expect(last).toBe(429);
    });

    it('si la base falla responde 502 (el navegador lo ignora)', async () => {
        rpcResult = { data: null, error: { message: 'boom' } };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { POST }: any = await import('@/app/api/client-events/route');
        expect((await POST(post({ events: [ev()] }))).status).toBe(502);
    });
});

describe('GET /api/cron/analytics-rollup', () => {
    const get = (auth?: string) => new Request('http://x/api/cron/analytics-rollup', { headers: auth ? { authorization: auth } : {} });
    beforeEach(() => { process.env.CRON_SECRET = 'un-secreto-de-mas-de-16-caracteres'; vi.spyOn(console, 'log').mockImplementation(() => {}); });

    it('sin el secreto responde 401 y no ejecuta nada', async () => {
        const { GET }: any = await import('@/app/api/cron/analytics-rollup/route');
        expect((await GET(get())).status).toBe(401);
        expect((await GET(get('Bearer otro'))).status).toBe(401);
        expect(rpcCalls).toHaveLength(0);
    });

    it('con el secreto ejecuta el resumen y devuelve lo que hizo', async () => {
        rpcResult = { data: { days_summarized: 3, events_purged: 10 }, error: null };
        const { GET }: any = await import('@/app/api/cron/analytics-rollup/route');
        const res = await GET(get('Bearer un-secreto-de-mas-de-16-caracteres'));
        expect(res.status).toBe(200);
        // Conserva el formato anterior (eventos de cliente) y suma el resumen de los eventos de plataforma.
        expect(await res.json()).toMatchObject({ ok: true, days_summarized: 3, events_purged: 10 });
        expect(rpcCalls.map(c => c[0]).sort()).toEqual(['rollup_client_events', 'rollup_platform_events']);
    });

    it('si falla responde 500 (Cloud Scheduler lo marca como fallo)', async () => {
        rpcResult = { data: null, error: { message: 'boom' } };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { GET }: any = await import('@/app/api/cron/analytics-rollup/route');
        expect((await GET(get('Bearer un-secreto-de-mas-de-16-caracteres'))).status).toBe(500);
    });
});
