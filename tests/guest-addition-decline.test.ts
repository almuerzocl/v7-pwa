import { describe, it, expect, vi } from 'vitest';
import { processGuestAdditionDeclines, buildDeclineNotice, type DeclineDeps } from '@/lib/server/guest-addition-decline';

const row = (over: Record<string, any> = {}) => ({
    id: 'res-1', restaurant_id: 'rest-1', organizer_id: 'org-1', unique_code: 'AB12', date_time: '2026-11-06T16:30:00Z', party_size: 10,
    metadata: { guest_addition_declined: { declined_party_size: 12, previous_party_size: 10, removed_guests: ['Ana', 'Beto <b>'] } }, ...over,
});

function deps(rows: any[], over: { profile?: any; sendOk?: boolean; rpcError?: any } = {}) {
    const rpc = vi.fn(async (name: string) => (name === 'claim_guest_addition_declines' ? { data: rows, error: over.rpcError ?? null } : { data: null, error: null }));
    const from = vi.fn((table: string) => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === 'restaurants' ? { name: 'Cri-Olla' } : (over.profile === undefined ? { email: 'org@x.cl', first_name: 'Esteban' } : over.profile) }) }) }),
    }));
    const send = vi.fn().mockResolvedValue({ success: over.sendOk ?? true });
    return { d: { admin: { rpc, from } as any, send } as DeclineDeps, rpc, send };
}

describe('processGuestAdditionDeclines', () => {
    it('envía el aviso al organizador y marca como enviado', async () => {
        const { d, rpc, send } = deps([row()]);
        const s = await processGuestAdditionDeclines({}, d);
        expect(s).toMatchObject({ claimed: 1, completed: 1, emailsSent: 1, failed: 0 });
        const mail = send.mock.calls[0][0];
        expect(mail.to).toBe('org@x.cl');
        expect(mail.text).toContain('aumento de tu reserva a 12 personas');
        expect(mail.text).toContain('confirmada para 10 personas');
        expect(mail.html).toContain('Beto &lt;b&gt;'); // HTML escapado
        expect(rpc).toHaveBeenCalledWith('mark_guest_addition_decline_notified', { p_id: 'res-1' });
    });
    it('si el envío falla no marca (el reclamo vence y se reintenta)', async () => {
        const { d, rpc } = deps([row()], { sendOk: false });
        expect(await processGuestAdditionDeclines({}, d)).toMatchObject({ failed: 1, completed: 0 });
        expect(rpc).not.toHaveBeenCalledWith('mark_guest_addition_decline_notified', expect.anything());
    });
    it('sin correo del organizador cierra el aviso sin enviar', async () => {
        const { d, rpc, send } = deps([row()], { profile: { email: null, first_name: 'X' } });
        expect(await processGuestAdditionDeclines({}, d)).toMatchObject({ skipped: 1 });
        expect(send).not.toHaveBeenCalled();
        expect(rpc).toHaveBeenCalledWith('mark_guest_addition_decline_notified', { p_id: 'res-1' });
    });
    it('sin filas reclamadas no hace nada', async () => {
        const { d, send } = deps([]);
        expect(await processGuestAdditionDeclines({}, d)).toMatchObject({ claimed: 0 });
        expect(send).not.toHaveBeenCalled();
    });
    it('un error al reclamar se propaga (el cron lo reporta)', async () => {
        const { d } = deps([], { rpcError: { message: 'boom' } });
        await expect(processGuestAdditionDeclines({}, d)).rejects.toThrow('boom');
    });
});

describe('buildDeclineNotice', () => {
    it('sin invitados quitados omite esa frase', () => {
        const n = buildDeclineNotice({ firstName: '', restaurantName: 'R', when: 'x', declined: 3, previous: 2, removed: [] });
        expect(n.text).not.toContain('no recibieron');
        expect(n.html).not.toContain('no recibieron');
    });
});
