import { describe, it, expect, vi } from 'vitest';
import { addGuestsToReservation, buildApprovalNotice, mapAddGuestsError, type AddGuestsDeps } from '@/lib/server/add-reservation-guests';

const G = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, name: `Inv ${i}`, email: `i${i}@x.cl` }));

function deps(over: Partial<{ rpc: any; profile: any; row: any; sendOk: boolean }> = {}) {
    const rpc = vi.fn().mockResolvedValue(over.rpc ?? { data: { success: true, needs_approval: false, party_size: 3, previous_party_size: 2 }, error: null });
    const from = vi.fn((table: string) => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === 'profiles' ? (over.profile ?? { email: 'org@x.cl', first_name: 'Esteban' }) : (over.row ?? { date_time: '2026-11-06T16:30:00Z', unique_code: 'ab12', restaurant: { name: 'Cri-Olla <b>' } }) }) }) }),
    }));
    const send = vi.fn().mockResolvedValue({ success: over.sendOk ?? true });
    const processConfirmations = vi.fn().mockResolvedValue(undefined);
    const matchUser = vi.fn().mockResolvedValue(null);
    const d: AddGuestsDeps = { admin: { rpc, from } as any, matchUser, send, processConfirmations };
    return { d, rpc, send, processConfirmations, matchUser };
}

describe('addGuestsToReservation', () => {
    it('dentro del límite: llama al RPC con el organizador y dispara el aviso en línea, sin correo de aprobación', async () => {
        const { d, rpc, send, processConfirmations } = deps();
        const r = await addGuestsToReservation('user-1', 'res-1', G(1), d);
        expect(r).toMatchObject({ success: true, needsApproval: false, partySize: 3, previousPartySize: 2, noticeSent: null });
        expect(rpc).toHaveBeenCalledWith('add_reservation_guests', expect.objectContaining({ p_reservation_id: 'res-1', p_actor_id: 'user-1' }));
        expect(processConfirmations).toHaveBeenCalledWith('res-1');
        expect(send).not.toHaveBeenCalled();
    });
    it('si queda sujeta a aprobación: avisa por correo al organizador y NO dispara invitaciones', async () => {
        const { d, send, processConfirmations } = deps({ rpc: { data: { success: true, needs_approval: true, party_size: 12, previous_party_size: 10 }, error: null } });
        const r = await addGuestsToReservation('user-1', 'res-1', G(2), d);
        expect(r).toMatchObject({ success: true, needsApproval: true, noticeSent: true });
        expect(processConfirmations).not.toHaveBeenCalled();
        const mail = send.mock.calls[0][0];
        expect(mail.to).toBe('org@x.cl');
        expect(mail.subject).toContain('sujeta a aprobación');
        expect(mail.text).toContain('de 10 a 12 personas');
        expect(mail.html).toContain('Cri-Olla &lt;b&gt;'); // HTML escapado
    });
    it('si el correo falla, la operación sigue siendo exitosa y lo informa', async () => {
        const { d } = deps({ rpc: { data: { success: true, needs_approval: true, party_size: 12, previous_party_size: 10 }, error: null }, sendOk: false });
        expect(await addGuestsToReservation('u', 'r', G(1), d)).toMatchObject({ success: true, noticeSent: false });
    });
    it('traduce los códigos del RPC', async () => {
        const { d } = deps({ rpc: { data: { success: false, code: 'no_capacity', remaining_seats: 1 }, error: null } });
        const r = await addGuestsToReservation('u', 'r', G(2), d);
        expect(r).toMatchObject({ success: false, code: 'no_capacity' });
        expect((r as any).error).toContain('1 cupo disponible');
    });
    it('un error del RPC no filtra detalles internos', async () => {
        const { d } = deps({ rpc: { data: null, error: { message: 'relation x does not exist' } } });
        const r = await addGuestsToReservation('u', 'r', G(1), d);
        expect(r).toMatchObject({ success: false });
        expect((r as any).error).not.toContain('relation');
    });
    it('rechaza 0 o más de 10 invitados sin llamar al RPC', async () => {
        const { d, rpc } = deps();
        expect(await addGuestsToReservation('u', 'r', [], d)).toMatchObject({ success: false, code: 'invalid_guests' });
        expect(await addGuestsToReservation('u', 'r', G(11), d)).toMatchObject({ success: false, code: 'invalid_guests' });
        expect(rpc).not.toHaveBeenCalled();
    });
    it('vincula al invitado con su cuenta si existe', async () => {
        const { d, rpc, matchUser } = deps();
        matchUser.mockResolvedValueOnce('11111111-1111-4111-8111-111111111111');
        await addGuestsToReservation('u', 'r', G(1), d);
        expect(rpc.mock.calls[0][1].p_guests[0].user_id).toBe('11111111-1111-4111-8111-111111111111');
    });
});

describe('mensajes', () => {
    it('sin cupos restantes', () => expect(mapAddGuestsError('no_capacity', 0)).toContain('no tiene cupos'));
    it('plural', () => expect(mapAddGuestsError('no_capacity', 3)).toContain('3 cupos disponibles'));
    it('el aviso escapa el nombre', () => expect(buildApprovalNotice({ firstName: '<i>', restaurantName: 'R', when: 'x', from: 1, to: 2, code: 'A' }).html).toContain('&lt;i&gt;'));
});
