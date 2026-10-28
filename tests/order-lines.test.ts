import { describe, expect, it } from 'vitest';
import { hasOptions, parseOrderLines } from '../src/lib/order-lines';

describe('líneas del pedido con opciones (mismo archivo que el dashboard)', () => {
    it('lee arreglo, texto JSON, nulo y basura; cantidad por defecto 1', () => {
        expect(parseOrderLines(null)).toEqual([]);
        expect(parseOrderLines('no json')).toEqual([]);
        expect(parseOrderLines(JSON.stringify([{ name: 'Pastel', quantity: 2 }]))).toEqual([{ quantity: 2, name: 'Pastel', options: [] }]);
        expect(parseOrderLines([{ name: 'X' }, null, 5])).toEqual([{ quantity: 1, name: 'X', options: [] }]);
    });
    it('toma los nombres del snapshot e ignora entradas inválidas', () => {
        const l = parseOrderLines([{ name: 'Pastel', options: [{ name: 'Papas' }, { name: '' }, null, { price_delta: 5 }] }]);
        expect(l[0].options).toEqual(['Papas']);
        expect(hasOptions(l)).toBe(true);
        expect(hasOptions(parseOrderLines([{ name: 'a' }]))).toBe(false);
    });
});
