import { beforeEach, describe, expect, it, vi } from 'vitest';

// Lote 0 (revisión de calidad 2026-10-28), hallazgo 10: la fila del pedido viene del navegador. Las columnas que solo debe poner
// el sistema (aprobación, avisos de correo, marca de personal, fechas) no pueden viajar en ella.
const { verifyUser, insert, revalidate } = vi.hoisted(() => ({ verifyUser: vi.fn(), insert: vi.fn(), revalidate: vi.fn() }));

vi.mock('@/utils/supabase/auth-check', () => ({ verifyUser }));
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ from: () => ({ insert: (row: unknown) => { insert(row); return { select: () => ({ single: async () => ({ data: { id: 'o1', status: 'PENDIENTE' }, error: null }) }) }; } }) }),
}));
vi.mock('@/lib/server/order-confirmation', () => ({ processOrderConfirmations: vi.fn() }));
vi.mock('@/lib/core-business/discount-checkout', () => ({
    revalidateChosenDiscount: revalidate,
    composeNotes: (n: unknown) => n ?? '',
    droppedDiscountMessage: () => '',
}));

import { createTakeawayOrder } from '../src/lib/takeaway/create-takeaway-order';

const CART_ROW = {
    user_id: 'u1', restaurant_id: 'r1', items: [{ id: 'm1', quantity: 1 }], total_amount: 5000, status: 'PENDIENTE',
    customer_name: 'Ana', customer_phone: '+569', unique_code: 'ABC123', user_reputation_snapshot: 90, account_type_snapshot: 'free',
    benefits_snapshot: {}, discount_data_snapshot: null, metadata: { special_requests: 'sin ají' },
};

describe('createTakeawayOrder: columnas del sistema', () => {
    beforeEach(() => {
        insert.mockReset();
        verifyUser.mockResolvedValue({ authorized: true, userId: 'u1' });
        revalidate.mockResolvedValue({ discount: null, dropped: null });
    });

    it('descarta las columnas que solo pone el sistema, aunque el navegador las mande', async () => {
        await createTakeawayOrder({
            ...CART_ROW,
            approved_at: '2026-10-29T10:00:00Z', confirmed_at: '2026-10-29T10:00:00Z', rejected_at: null,
            confirmation_notified_at: '2026-10-29T10:00:00Z', confirmation_notify_attempts: 99, confirmation_notify_claimed_at: '2026-10-29T10:00:00Z',
            created_by_staff: true, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z', id: 'forzado',
        } as never);

        const sent = insert.mock.calls[0][0] as Record<string, unknown>;
        for (const col of ['approved_at', 'confirmed_at', 'rejected_at', 'confirmation_notified_at', 'confirmation_notify_attempts',
            'confirmation_notify_claimed_at', 'created_by_staff', 'created_at', 'updated_at', 'id']) {
            expect(sent, col).not.toHaveProperty(col);
        }
    });

    it('control: el pedido normal del carrito llega completo', async () => {
        await createTakeawayOrder(CART_ROW as never);

        const sent = insert.mock.calls[0][0] as Record<string, unknown>;
        for (const col of Object.keys(CART_ROW).filter((c) => c !== 'metadata' && c !== 'discount_data_snapshot')) {
            expect(sent, col).toHaveProperty(col, (CART_ROW as Record<string, unknown>)[col]);
        }
        expect((sent.metadata as Record<string, unknown>).special_requests).toBe('sin ají');
    });
});
