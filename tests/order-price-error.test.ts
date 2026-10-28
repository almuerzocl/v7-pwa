import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderPriceError, priceErrorFromDb } from '../src/lib/takeaway/order-price-error';
import { createTakeawayOrderRequest } from '../src/lib/takeaway/create-takeaway-order-client';

describe('rechazo de precio de la base', () => {
    it('solo reconoce SQLSTATE PR001 con código estable', () => {
        expect(priceErrorFromDb(null)).toBeNull();
        expect(priceErrorFromDb({ code: '23505', hint: 'price_mismatch', message: 'x' })).toBeNull();
        expect(priceErrorFromDb({ code: 'PR001', hint: null, message: 'x' })).toBeNull();
        expect(priceErrorFromDb({ code: 'PR001', hint: 'option_unavailable', message: 'La opción "Queso" ya no está disponible' })).toEqual({
            hint: 'option_unavailable', message: 'La opción "Queso" ya no está disponible', expectedTotal: undefined, lines: undefined });
    });
    it('price_mismatch trae el total esperado y las líneas corregidas', () => {
        const e = priceErrorFromDb({ code: 'PR001', hint: 'price_mismatch', message: 'Los precios cambiaron', details: JSON.stringify({ expected_total: 7300, items: [{ id: 'p1', unit_price: 7300 }] }) });
        expect(e?.expectedTotal).toBe(7300);
        expect(e?.lines?.[0].unit_price).toBe(7300);
    });
    it('un detalle ilegible no rompe', () => {
        expect(priceErrorFromDb({ code: 'PR001', hint: 'price_mismatch', message: 'm', details: '{no json' })?.lines).toBeUndefined();
    });
});

describe('cliente de creación de pedido', () => {
    afterEach(() => vi.unstubAllGlobals());
    const respond = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 422, headers: { 'content-type': 'application/json' } })));
    it('convierte code price_error en OrderPriceError con el hint', async () => {
        respond({ success: false, error: 'Los precios cambiaron', code: 'price_error', priceError: { hint: 'price_mismatch', message: 'Los precios cambiaron', expectedTotal: 7300, lines: [] } });
        const err = await createTakeawayOrderRequest({}).catch((e) => e);
        expect(err).toBeInstanceOf(OrderPriceError);
        expect(err.hint).toBe('price_mismatch');
        expect(err.expectedTotal).toBe(7300);
    });
    it('un rechazo cualquiera sigue siendo un Error normal (stock, sesión)', async () => {
        respond({ success: false, error: 'SIN_STOCK|Pastel|0' });
        const err = await createTakeawayOrderRequest({}).catch((e) => e);
        expect(err).not.toBeInstanceOf(OrderPriceError);
        expect(err.message).toContain('SIN_STOCK');
    });
});
