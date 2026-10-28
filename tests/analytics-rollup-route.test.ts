import { describe, it, expect, vi, beforeEach } from 'vitest';

let results: Record<string, { data: any; error: any }> = {};
const calls: string[] = [];
const filters: string[] = [];
let emailDelete: { count: number | null; error: any } = { count: 4, error: null };
vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        rpc: async (name: string) => { calls.push(name); return results[name]; },
        from: (table: string) => {
            const q: any = {
                delete: () => q,
                eq: (c: string, v: string) => { filters.push(`${c}=${v}`); return q; },
                lt: (c: string, v: string) => { filters.push(`${c}<${v}`); return q; },
                then: (res: any) => { calls.push(`delete:${table}`); return Promise.resolve(emailDelete).then(res); },
            };
            return q;
        },
    }),
}));

const req = (auth?: string) => new Request('http://x/api/cron/analytics-rollup', { headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
    calls.length = 0;
    filters.length = 0;
    emailDelete = { count: 4, error: null };
    results = {
        rollup_client_events: { data: { days_summarized: 3, events_purged: 1 }, error: null },
        rollup_platform_events: { data: { rows_summarized: 5, events_purged: 2 }, error: null },
    };
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    process.env.CRON_SECRET = 'secreto-de-prueba-largo';
});

describe('GET /api/cron/analytics-rollup', () => {
    it('exige el secreto y no toca la base sin él', async () => {
        const { GET }: any = await import('@/app/api/cron/analytics-rollup/route');
        expect((await GET(req())).status).toBe(401);
        expect((await GET(req('Bearer otro-secreto-cualquiera'))).status).toBe(401);
        expect(calls).toHaveLength(0);
    });

    it('resume las dos fuentes y conserva el formato anterior', async () => {
        const { GET }: any = await import('@/app/api/cron/analytics-rollup/route');
        const res = await GET(req('Bearer secreto-de-prueba-largo'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(calls.sort()).toEqual(['delete:error_logs', 'rollup_client_events', 'rollup_platform_events']);
        expect(body.email_log).toEqual({ rows_purged: 4 });
        expect(body.ok).toBe(true);
        expect(body.client_events).toEqual({ days_summarized: 3, events_purged: 1 });
        expect(body.platform_events).toEqual({ rows_summarized: 5, events_purged: 2 });
        expect(body.days_summarized).toBe(3); // formato anterior
    });

    it('si una falla, la otra se ejecuta igual y la respuesta es 500', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        results.rollup_platform_events = { data: null, error: { message: 'boom' } };
        const { GET }: any = await import('@/app/api/cron/analytics-rollup/route');
        const res = await GET(req('Bearer secreto-de-prueba-largo'));
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.platform_events).toEqual({ error: 'boom' });
        expect(body.client_events).toEqual({ days_summarized: 3, events_purged: 1 });
        expect(calls).toHaveLength(3);
    });

    it('borra solo correos enviados de la PWA con más de 12 meses', async () => {
        const { GET }: any = await import('@/app/api/cron/analytics-rollup/route');
        await GET(req('Bearer secreto-de-prueba-largo'));
        expect(filters.slice(0, 2)).toEqual(['app=pwa', 'source=email-sent']);
        const cut = new Date(filters[2].split('<')[1]).getTime();
        const expected = new Date(); expected.setMonth(expected.getMonth() - 12);
        expect(Math.abs(cut - expected.getTime())).toBeLessThan(60_000);
    });

    it('si falla el borrado de correos, las otras fuentes igual corren y responde 500', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        emailDelete = { count: null, error: { message: 'sin permiso' } };
        const { GET }: any = await import('@/app/api/cron/analytics-rollup/route');
        const res = await GET(req('Bearer secreto-de-prueba-largo'));
        expect(res.status).toBe(500);
        expect((await res.json()).email_log).toEqual({ error: 'sin permiso' });
        expect(calls).toHaveLength(3);
    });
});
