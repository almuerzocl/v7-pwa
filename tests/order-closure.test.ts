import { beforeEach, describe, expect, it, vi } from 'vitest';

let byStatus: Record<string, any[]>, updates: any[], inserts: any[], updateResult: (id: string) => any[], insertError: any, selectError: any, selects: any[];
const sendEmail = vi.fn(async (..._a: any[]) => ({ success: true }));

const admin = {
    from: (table: string) => {
        if (table === 'notifications') return { insert: async (p: any) => { inserts.push(p); return { error: insertError }; } };
        if (table === 'restaurants') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Cri-Olla' } }) }) }) };
        if (table === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: 'c@x.cl', first_name: 'Ana' } }) }) }) };
        return {
            select: () => {
                const q: any = { _s: '', eq: (c: string, v: any) => { if (c === 'status') q._s = v; return q; }, lt: (c: string, v: any) => { selects.push([q._s, c, v]); return q; }, limit: () => q,
                    then: (ok: any) => ok({ data: byStatus[q._s] || [], error: selectError }) };
                return q;
            },
            update: (p: any) => {
                const chain: any = { _id: '', _st: '', eq: (c: string, v: any) => { if (c === 'id') chain._id = v; if (c === 'status') chain._st = v; return chain; },
                    select: async () => { updates.push({ id: chain._id, onlyIf: chain._st, ...p }); return { data: updateResult(chain._id), error: null }; } };
                return chain;
            },
        };
    },
};
vi.mock('@/lib/server/email', () => ({ sendEmail: (...a: any[]) => sendEmail(...a) }));

import { closeStaleOrders } from '../src/lib/server/order-closure';
import { GET } from '../src/app/api/cron/close-day/route';

const CUT = '2026-10-06T03:00:00.000Z';
const row = (id: string, over: any = {}) => ({ id, user_id: 'u-' + id, restaurant_id: 'r1', unique_code: id.toUpperCase(), timestamps: { PENDIENTE: { at: 'x' } }, metadata: {}, ...over });

describe('cierre del día de pedidos', () => {
    beforeEach(() => {
        byStatus = {}; updates = []; inserts = []; selects = []; updateResult = (id) => [{ id }]; insertError = null; selectError = null; sendEmail.mockClear();
    });

    it('lee solo los abiertos anteriores al corte, por cada estado', async () => {
        await closeStaleOrders(admin, CUT);
        expect(selects.map((s) => s[0])).toEqual(['PENDIENTE', 'APROBADA', 'PREPARANDO', 'LISTO']);
        expect(selects.every((s) => s[1] === 'created_at' && s[2] === CUT)).toBe(true);
    });
    it('PENDIENTE y APROBADA pasan a CANCELADO (no penaliza); PREPARANDO y LISTO a NO_RETIRADO (penaliza)', async () => {
        byStatus = { PENDIENTE: [row('p')], APROBADA: [row('a')], PREPARANDO: [row('c')], LISTO: [row('l')] };
        const r = await closeStaleOrders(admin, CUT);
        expect(Object.fromEntries(updates.map((u) => [u.id, u.status]))).toEqual({ p: 'CANCELADO', a: 'CANCELADO', c: 'NO_RETIRADO', l: 'NO_RETIRADO' });
        expect(r).toMatchObject({ cancelled: 2, noRetirado: 2, notified: 4, emailed: 4, conflicts: 0 });
    });
    it('un APROBADA nunca pasa a NO_RETIRADO (el cliente no tiene la culpa)', async () => {
        byStatus = { APROBADA: [row('a')] };
        await closeStaleOrders(admin, CUT);
        expect(updates.every((u) => u.status !== 'NO_RETIRADO')).toBe(true);
    });
    it('deja marca con actor system y motivo, conserva el historial y escribe con condición de estado', async () => {
        byStatus = { LISTO: [row('l', { timestamps: { LISTO: { at: 'y' } } })] };
        await closeStaleOrders(admin, CUT);
        expect(updates[0].onlyIf).toBe('LISTO');
        expect(updates[0].timestamps.LISTO).toEqual({ at: 'y' });
        expect(updates[0].timestamps.NO_RETIRADO).toMatchObject({ actor_id: null, actor_role: 'system', reason: 'Cierre del día: el pedido no se retiró' });
    });
    it('SIEMPRE avisa al cliente: tipo propio para no retirado, tipo de pedidos para la cancelación, y correo', async () => {
        byStatus = { PENDIENTE: [row('p')], LISTO: [row('l')] };
        await closeStaleOrders(admin, CUT);
        const byRelated = Object.fromEntries(inserts.map((i) => [i.related_id, i]));
        expect(byRelated.l).toMatchObject({ type: 'NO_RETIRADO', user_id: 'u-l', actor_role: 'system' });
        expect(byRelated.l.message).toContain('afecta tu reputación');
        expect(byRelated.p).toMatchObject({ type: 'TAKEAWAY' });
        expect(byRelated.p.message).toContain('No afecta tu reputación');
        expect(sendEmail).toHaveBeenCalledTimes(2);
        expect(sendEmail.mock.calls[0][0].to).toBe('c@x.cl');
    });
    it('sin cuenta (pedido de invitado) avisa solo por el correo guardado', async () => {
        byStatus = { LISTO: [row('l', { user_id: null, metadata: { customer_email: 'inv@x.cl' } })] };
        const r = await closeStaleOrders(admin, CUT);
        expect(inserts).toEqual([]);
        expect(r.emailed).toBe(1);
    });
    it('si el pedido cambió entre la lectura y la escritura: conflicto, sin aviso', async () => {
        byStatus = { LISTO: [row('l')] };
        updateResult = () => [];
        const r = await closeStaleOrders(admin, CUT);
        expect(r).toMatchObject({ noRetirado: 0, conflicts: 1 });
        expect(inserts).toEqual([]);
        expect(sendEmail).not.toHaveBeenCalled();
    });
    it('un aviso que falla no deshace el cierre ni frena a los demás', async () => {
        byStatus = { LISTO: [row('l'), row('m')] };
        insertError = new Error('boom');
        const r = await closeStaleOrders(admin, CUT);
        expect(r).toMatchObject({ noRetirado: 2, notified: 0 });
        expect(updates).toHaveLength(2);
    });
    it('un error de lectura se propaga (la ruta responde 500 y el Scheduler reintenta)', async () => {
        selectError = new Error('lectura');
        await expect(closeStaleOrders(admin, CUT)).rejects.toThrow('lectura');
    });
});

describe('/api/cron/close-day', () => {
    it('sin el secreto: 401 y no toca pedidos', async () => {
        vi.stubEnv('CRON_SECRET', 'un-secreto-bastante-largo-123');
        const res = await GET(new Request('http://x/api/cron/close-day', { headers: { authorization: 'Bearer otro' } }));
        expect(res.status).toBe(401);
    });
});
