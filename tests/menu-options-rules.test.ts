import { describe, expect, it } from 'vitest';
import {
    baseUnitPrice, groupUnsatisfiable, normalizeGroupConfig, optionsSummary, orderTotal, unitPrice, validateGroupConfig, validateOptionName,
    validatePriceDelta, validateSelection, type MenuOptionGroup,
} from '../src/lib/menu-options';

const opt = (id: string, name: string, price_delta = 0, is_available = true) => ({ id, name, price_delta, is_available });
const grp = (o: Partial<MenuOptionGroup> & { id: string }): MenuOptionGroup => ({ name: o.id, kind: 'single', required: false, min_select: 0, max_select: 1, options: [], ...o });

describe('configuración de un grupo', () => {
    it('«elegir una» fija máximo 1 y el mínimo sale de «obligatorio»', () => {
        expect(normalizeGroupConfig({ kind: 'single', required: true, min_select: 0, max_select: 5 })).toEqual({ kind: 'single', required: true, min_select: 1, max_select: 1 });
        expect(normalizeGroupConfig({ kind: 'single', required: false, min_select: 3, max_select: 3 })).toEqual({ kind: 'single', required: false, min_select: 0, max_select: 1 });
    });
    it('«varias»: obligatorio equivale a mínimo >= 1 en ambos sentidos', () => {
        expect(normalizeGroupConfig({ kind: 'multiple', required: true, min_select: 0, max_select: 3 })).toMatchObject({ required: true, min_select: 1 });
        expect(normalizeGroupConfig({ kind: 'multiple', required: false, min_select: 2, max_select: 3 })).toMatchObject({ required: true, min_select: 2 });
        expect(normalizeGroupConfig({ kind: 'multiple', required: false, min_select: 0, max_select: 3 })).toMatchObject({ required: false, min_select: 0 });
    });
    it('valida bordes: mínimo 0, máximo 1 y 20, mínimo = máximo', () => {
        const ok = (min: number, max: number, kind: 'single' | 'multiple' = 'multiple') => validateGroupConfig({ kind, required: min >= 1, min_select: min, max_select: max });
        expect(ok(0, 1)).toBeNull();
        expect(ok(2, 2)).toBeNull();
        expect(ok(0, 20)).toBeNull();
        expect(ok(0, 21)).toMatch(/hasta 20/);
        expect(ok(0, 0)).toMatch(/al menos 1/);
        expect(ok(-1, 2)).toMatch(/negativo/);
        expect(ok(3, 2)).toMatch(/mayor que el máximo/);
        expect(ok(0, 1.5)).toMatch(/enteros/);
        expect(ok(0, 2, 'single')).toMatch(/máximo 1/);
        expect(validateGroupConfig({ kind: 'multiple', required: true, min_select: 0, max_select: 2 })).toMatch(/Obligatorio/);
        expect(validateGroupConfig({ kind: 'otro' as never, required: false, min_select: 0, max_select: 1 })).toMatch(/tipo/);
    });
});

describe('nombre y recargo', () => {
    it('nombre: vacío, solo espacios, no texto y 61 caracteres fallan; 60 pasa', () => {
        for (const n of ['', '   ', null, 4]) expect(validateOptionName(n), String(n)).toMatch(/Escribe/);
        expect(validateOptionName('x'.repeat(61))).toMatch(/hasta 60/);
        expect(validateOptionName('x'.repeat(60))).toBeNull();
    });
    it('recargo: entero 0..1.000.000; negativo, decimal, texto y null fallan', () => {
        expect(validatePriceDelta(0)).toBeNull();
        expect(validatePriceDelta(1_000_000)).toBeNull();
        for (const v of [-1, 1.5, 1_000_001, '500', null, NaN]) expect(validatePriceDelta(v), String(v)).toMatch(/entero/);
    });
});

describe('selección y precio (misma regla que la base)', () => {
    const acomp = grp({ id: 'g1', name: 'Acompañamiento', required: true, min_select: 1, options: [opt('papas', 'Papas'), opt('arroz', 'Arroz'), opt('ens', 'Ensalada', 500, false)] });
    const extras = grp({ id: 'g2', name: 'Agregados', kind: 'multiple', max_select: 2, options: [opt('q', 'Queso', 800), opt('p', 'Palta', 1200), opt('h', 'Huevo', 600)] });
    const groups = [acomp, extras];

    it('obligatorio sin elegir => option_min; elegirlo => ok', () => {
        expect(validateSelection(groups, [])?.code).toBe('option_min');
        expect(validateSelection(groups, ['papas'])).toBeNull();
    });
    it('máximo: dos en «una» o tres en «hasta 2» => option_max; en el borde pasa', () => {
        expect(validateSelection(groups, ['papas', 'arroz'])?.code).toBe('option_max');
        expect(validateSelection(groups, ['papas', 'q', 'p', 'h'])?.code).toBe('option_max');
        expect(validateSelection(groups, ['papas', 'q', 'p'])).toBeNull();
    });
    it('opción apagada, de otro plato, repetida', () => {
        expect(validateSelection(groups, ['ens'])?.code).toBe('option_unavailable');
        expect(validateSelection(groups, ['papas', 'otra'])?.code).toBe('option_invalid');
        expect(validateSelection(groups, ['papas', 'papas'])?.code).toBe('option_duplicate');
    });
    it('una opción inválida se reporta antes que un mínimo faltante (mismo orden que la base)', () => {
        expect(validateSelection(groups, ['otra'])?.code).toBe('option_invalid');
    });
    it('precio: base + recargos; gratuitas no suman; cantidad multiplica', () => {
        expect(unitPrice(6500, groups, ['papas'])).toBe(6500);
        expect(unitPrice(6500, groups, ['arroz', 'q', 'p'])).toBe(8500);
        expect(orderTotal([{ unit_price: 8500, quantity: 2 }, { unit_price: 3000, quantity: 1 }])).toBe(20000);
        expect(orderTotal([])).toBe(0);
    });
    it('precio base para llevar: takeaway_price 0 o vacío usa el local', () => {
        expect(baseUnitPrice({ price: 6900, takeaway_price: 6500 })).toBe(6500);
        expect(baseUnitPrice({ price: 3000, takeaway_price: 0 })).toBe(3000);
        expect(baseUnitPrice({ price: 3000, takeaway_price: null })).toBe(3000);
        expect(baseUnitPrice({ price: 3000 })).toBe(3000);
    });
    it('un grupo con mínimo mayor que las opciones disponibles es insatisfacible', () => {
        expect(groupUnsatisfiable({ min_select: 1, options: [opt('a', 'a', 0, false)] })).toBe(true);
        expect(groupUnsatisfiable({ min_select: 1, options: [opt('a', 'a')] })).toBe(false);
        expect(groupUnsatisfiable({ min_select: 0, options: [] })).toBe(false);
    });
    it('resumen para ticket y comanda', () => {
        expect(optionsSummary([{ name: 'Papas fritas' }, { name: 'Queso' }])).toBe('Papas fritas, Queso');
        expect(optionsSummary(null)).toBe('');
    });
});
