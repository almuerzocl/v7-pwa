import { beforeEach, describe, expect, it, vi } from 'vitest';

// Lote 0 de la revisión de calidad (2026-10-28), hallazgo 2: «Mis pedidos» no puede apropiarse de pedidos
// sin dueño usando datos del perfil que el usuario edita (teléfono) ni un correo sin verificar.
const { verifyUser, getUser, createSb } = vi.hoisted(() => ({
    verifyUser: vi.fn(),
    getUser: vi.fn(),
    createSb: vi.fn(),
}));

vi.mock('@/utils/supabase/auth-check', () => ({ verifyUser }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser } }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: createSb }));

import { fetchUserOrdersAction } from '../src/app/actions/takeaway-actions';

// takeaway-actions guarda su cliente admin en un singleton: se le entrega uno estable que delega en la base falsa de cada prueba.
let current: { from: (t: string) => any };
const stableClient = { from: (t: string) => current.from(t) };

const PROFILE = { email: 'ana@correo.cl', phone_number: '+56911112222' };

/** Cliente admin falso: cada consulta registra sus filtros y devuelve un pedido sin dueño si no filtra por user_id. */
function fakeDb() {
    const queries: string[][] = [];
    const updates: string[] = [];
    const db = {
        from: (table: string) => {
            if (table === 'profiles') {
                return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: PROFILE, error: null }) }) }) };
            }
            const filters: string[] = [];
            const b: any = {
                select: () => b, order: () => b, limit: () => b,
                eq: (c: string) => { filters.push(`eq:${c}`); return b; },
                is: (c: string) => { filters.push(`is:${c}`); return b; },
                filter: (c: string) => { filters.push(`filter:${c}`); return b; },
                update: () => ({ eq: async (_c: string, id: string) => { updates.push(id); return { error: null }; } }),
                then: (res: (v: unknown) => void) => {
                    queries.push(filters);
                    const own = filters.includes('eq:user_id');
                    res({ data: own ? [] : [{ id: `orphan-${queries.length}`, user_id: null, created_at: '2026-10-01T10:00:00Z' }], error: null });
                },
            };
            return b;
        },
    };
    return { db, queries, updates };
}

describe('fetchUserOrdersAction: vínculo de pedidos sin dueño', () => {
    beforeEach(() => {
        verifyUser.mockReset();
        getUser.mockReset();
        createSb.mockReset();
        createSb.mockReturnValue(stableClient);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        verifyUser.mockResolvedValue({ authorized: true, userId: 'u1' });
    });

    it('nunca consulta pedidos ajenos por el teléfono del perfil (no está verificado)', async () => {
        getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'ana@correo.cl', email_confirmed_at: '2026-01-01' } } });
        const f = fakeDb();
        current = f.db;

        await fetchUserOrdersAction('u1');

        expect(f.queries.flat()).not.toContain('eq:customer_phone');
    });

    it('con el correo SIN verificar no consulta ni vincula pedidos sin dueño', async () => {
        getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'ana@correo.cl', email_confirmed_at: null } } });
        const f = fakeDb();
        current = f.db;

        const r = await fetchUserOrdersAction('u1');

        expect(f.queries.flat()).not.toContain('filter:metadata->>customer_email');
        expect(r.orders).toEqual([]);
        expect(f.updates).toEqual([]);
    });

    it('con el correo verificado vincula solo los pedidos que coinciden por ese correo', async () => {
        getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'ana@correo.cl', email_confirmed_at: '2026-01-01' } } });
        const f = fakeDb();
        current = f.db;

        const r = await fetchUserOrdersAction('u1');
        await new Promise((res) => setTimeout(res, 0));

        expect(f.queries.flat()).toContain('filter:metadata->>customer_email');
        expect(r.orders.map((o: any) => o.id)).toHaveLength(1);
        expect(f.updates).toHaveLength(1);
    });
});
