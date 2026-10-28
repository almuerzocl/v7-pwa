import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDiscountNote, stripDiscountNote, type InstitutionDiscount } from '../src/lib/core-business/discounts';
import { composeNotes, findChosenDiscount, revalidateChosenDiscount } from '../src/lib/core-business/discount-checkout';

const D: InstitutionDiscount = {
    discount_id: 'd1', institution_id: 'i1', institution_name: 'Banco Uno', institution_logo_url: null,
    discount_name: '10% socios', amount: 10, amount_type: 'percent', conditions: null,
};
const base = { userId: 'u', restaurantId: 'r', serviceType: 'reservation' as const, appliedDiscountId: 'd1', snapshot: [D] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('notas de descuento', () => {
    it('stripDiscountNote quita la nota del navegador y deja el resto', () => {
        const txt = `Mesa afuera\n${buildDiscountNote(D)}\nSin gluten`;
        expect(stripDiscountNote(txt)).toBe('Mesa afuera\nSin gluten');
        expect(stripDiscountNote(null)).toBe('');
    });
    it('composeNotes solo agrega la nota si el descuento sigue vigente', () => {
        expect(composeNotes('Hola', D)).toBe(`Hola\n${buildDiscountNote(D)}`);
        expect(composeNotes(`Hola\n${buildDiscountNote(D)}`, null)).toBe('Hola');
    });
});

describe('findChosenDiscount', () => {
    it('lo encuentra en el snapshot, o null', () => {
        expect(findChosenDiscount('d1', [D])).toEqual(D);
        expect(findChosenDiscount('x', [D])).toBeNull();
        expect(findChosenDiscount(null, [D])).toBeNull();
        expect(findChosenDiscount('d1', 'no-es-lista')).toBeNull();
    });
});

describe('revalidateChosenDiscount (nunca bloquea)', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        vi.stubEnv('DISCOUNTS_SERVICE_URL', 'http://localhost:8099'); // http:// = sin token
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchMock.mockReset();
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('sin descuento elegido: no llama al servicio', async () => {
        const r = await revalidateChosenDiscount({ ...base, appliedDiscountId: null });
        expect(r).toEqual({ discount: null, dropped: null });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('vigente: devuelve el descuento y llama a /v1/validate con el servicio y la fecha', async () => {
        fetchMock.mockResolvedValue(json(200, { valid: true, reason: 'OK' }));
        const r = await revalidateChosenDiscount({ ...base, date: '2026-10-05' });
        expect(r).toEqual({ discount: D, dropped: null });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('http://localhost:8099/v1/validate');
        expect(JSON.parse(init.body)).toMatchObject({ discountId: 'd1', serviceType: 'reservation', date: '2026-10-05' });
    });

    it('ya no vigente: se descarta con razón NOT_VALID', async () => {
        fetchMock.mockResolvedValue(json(200, { valid: false, reason: 'OUT_OF_DATE_RANGE' }));
        const r = await revalidateChosenDiscount(base);
        expect(r.discount).toBeNull();
        expect(r.dropped?.reason).toBe('NOT_VALID');
    });

    it('servicio caído (503): se descarta con razón UNAVAILABLE, sin lanzar', async () => {
        fetchMock.mockResolvedValue(json(503, {}));
        const r = await revalidateChosenDiscount(base);
        expect(r.discount).toBeNull();
        expect(r.dropped?.reason).toBe('UNAVAILABLE');
    });

    it('error de red: UNAVAILABLE, sin lanzar', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));
        const r = await revalidateChosenDiscount(base);
        expect(r.dropped?.reason).toBe('UNAVAILABLE');
    });

    it('sin DISCOUNTS_SERVICE_URL: UNAVAILABLE, sin llamar', async () => {
        vi.stubEnv('DISCOUNTS_SERVICE_URL', '');
        const r = await revalidateChosenDiscount(base);
        expect(r.dropped?.reason).toBe('UNAVAILABLE');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('el id elegido no está en el snapshot: NOT_VALID sin consultar', async () => {
        const r = await revalidateChosenDiscount({ ...base, snapshot: [] });
        expect(r.dropped?.reason).toBe('NOT_VALID');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
