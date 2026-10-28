import { describe, expect, it } from 'vitest';
import { applyServerLines, buildSelectedOptions, cartLineKey, keyOf } from '../src/lib/cart-lines';
import { shapeOptionGroups } from '../src/lib/menu-option-groups';
import type { MenuOptionGroup } from '../src/lib/menu-options';

const groups: MenuOptionGroup[] = [
    { id: 'g1', name: 'Acompañamiento', kind: 'single', required: true, min_select: 1, max_select: 1, options: [
        { id: 'papas', name: 'Papas', price_delta: 0, is_available: true }, { id: 'arroz', name: 'Arroz', price_delta: 0, is_available: true }] },
    { id: 'g2', name: 'Agregados', kind: 'multiple', required: false, min_select: 0, max_select: 2, options: [
        { id: 'queso', name: 'Queso', price_delta: 800, is_available: true }, { id: 'palta', name: 'Palta', price_delta: 1200, is_available: true }] },
];

describe('clave de línea del carrito', () => {
    it('sin opciones es el id del plato (carritos antiguos siguen válidos)', () => {
        expect(cartLineKey('p1')).toBe('p1');
        expect(cartLineKey('p1', [])).toBe('p1');
        expect(keyOf({ id: 'p1' })).toBe('p1');
        expect(keyOf({ id: 'p1', lineKey: 'p1#a' })).toBe('p1#a');
    });
    it('no depende del orden en que se eligieron las opciones, y distingue combinaciones', () => {
        expect(cartLineKey('p1', ['b', 'a'])).toBe(cartLineKey('p1', ['a', 'b']));
        expect(cartLineKey('p1', ['a'])).not.toBe(cartLineKey('p1', ['a', 'b']));
        expect(cartLineKey('p1', ['a'])).not.toBe(cartLineKey('p2', ['a']));
        expect(cartLineKey('p1', ['a'])).not.toBe('p1');
    });
});

describe('snapshot de lo elegido', () => {
    it('sale en el orden de los grupos y opciones, no en el de los clics', () => {
        const s = buildSelectedOptions(groups, ['palta', 'queso', 'arroz']);
        expect(s.map((o) => o.name)).toEqual(['Arroz', 'Queso', 'Palta']);
        expect(s[1]).toEqual({ option_id: 'queso', group_id: 'g2', group_name: 'Agregados', name: 'Queso', price_delta: 800 });
    });
    it('ignora ids que no son del plato', () => {
        expect(buildSelectedOptions(groups, ['otra'])).toEqual([]);
        expect(buildSelectedOptions(groups, [])).toEqual([]);
    });
});

describe('precios corregidos por el servidor', () => {
    const cart = [
        { id: 'p1', lineKey: cartLineKey('p1', ['papas', 'queso']), price: 7000, basePrice: 6500, quantity: 1 },
        { id: 'p2', price: 3000, quantity: 2 },
    ];
    it('actualiza la línea cuyo plato y opciones coinciden y deja el resto', () => {
        const out = applyServerLines(cart, [
            { id: 'p1', options: [{ option_id: 'queso' }, { option_id: 'papas' }], unit_price: 7600, base_price: 6800 },
            { id: 'p2', options: [], unit_price: 3000, base_price: 3000 },
        ]);
        expect(out[0]).toMatchObject({ price: 7600, basePrice: 6800 });
        expect(out[1].price).toBe(3000);
        expect(cart[0].price).toBe(7000); // no muta
    });
    it('una línea que el servidor no devolvió, o sin precio, queda igual', () => {
        expect(applyServerLines(cart, [])).toEqual(cart);
        expect(applyServerLines(cart, [{ id: 'p1', options: [{ option_id: 'queso' }, { option_id: 'papas' }] }])[0].price).toBe(7000);
        expect(applyServerLines(cart, [{ options: [], unit_price: 1 }])).toEqual(cart);
    });
});

describe('forma de las opciones leídas de la base', () => {
    const row = (item_id: string, position: number | null, gid: string, name: string, options: Array<[string, string, number, boolean, number | null]>) => ({
        item_id, position, group: { id: gid, name, kind: 'single' as const, required: false, min_select: 0, max_select: 1,
            options: options.map(([id, n, d, a, p]) => ({ id, name: n, price_delta: d, is_available: a, position: p })) },
    });
    it('ordena grupos por posición en el plato y opciones por posición, por plato', () => {
        const out = shapeOptionGroups([
            row('i1', 1, 'gB', 'Salsas', [['b2', 'Mostaza', 0, true, 1], ['b1', 'Ají', 0, true, 0]]),
            row('i1', 0, 'gA', 'Acomp', [['a1', 'Papas', 0, true, 0]]),
            row('i2', 0, 'gA', 'Acomp', [['a1', 'Papas', 0, false, 0]]),
        ]);
        expect(out.i1.map((g) => g.id)).toEqual(['gA', 'gB']);
        expect(out.i1[1].options.map((o) => o.name)).toEqual(['Ají', 'Mostaza']);
        expect(out.i2[0].options[0].is_available).toBe(false);
    });
    it('tolera filas sin grupo, sin opciones, nulas o posiciones nulas', () => {
        expect(shapeOptionGroups(null)).toEqual({});
        expect(shapeOptionGroups([{ item_id: 'i', position: null, group: null }])).toEqual({});
        const out = shapeOptionGroups([{ item_id: 'i', position: null, group: { id: 'g', name: 'G', kind: 'multiple', required: false, min_select: 0, max_select: 2, options: null } }]);
        expect(out.i[0].options).toEqual([]);
    });
});
