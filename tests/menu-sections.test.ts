import { describe, expect, it } from 'vitest';
import { buildMenuSections, DAILY_SECTION_ID, OTHER_SECTION_ID, type MenuCategoryRow } from '../src/lib/menu-sections';

const cat = (id: string, name: string, position: number, is_visible: boolean | null = true): MenuCategoryRow => ({ id, name, position, is_visible });
const it_ = (id: string, category_id: string | null, position = 0, extra: Record<string, unknown> = {}) => ({ id, name: id, category_id, position, ...extra });
const ids = (s: ReturnType<typeof buildMenuSections>) => s.map((x) => x.id);

describe('secciones de la carta del cliente', () => {
    const cats = [cat('b', 'Postres', 1), cat('a', 'Fondos', 0), cat('c', 'Bebidas', 2)];

    it('ordena las categorías por la posición que define el restaurante, no alfabéticamente', () => {
        const s = buildMenuSections(cats, [it_('1', 'a'), it_('2', 'b'), it_('3', 'c')]);
        expect(ids(s)).toEqual(['a', 'b', 'c']);
        expect(s.map((x) => x.name)).toEqual(['Fondos', 'Postres', 'Bebidas']);
    });
    it('reordenar cambia el resultado sin tocar los platos', () => {
        const items = [it_('1', 'a'), it_('2', 'b'), it_('3', 'c')];
        const reordered = [cat('b', 'Postres', 0), cat('a', 'Fondos', 1), cat('c', 'Bebidas', 2)];
        expect(ids(buildMenuSections(reordered, items))).toEqual(['b', 'a', 'c']);
    });
    it('ordena los platos de una categoría por posición y desempata por nombre', () => {
        const s = buildMenuSections(cats, [it_('z', 'a', 1), it_('y', 'a', 0), it_('b', 'a', 1, { name: 'Alfa' })]);
        expect(s[0].items.map((i) => i.id)).toEqual(['y', 'b', 'z']);
    });
    it('no muestra categorías sin platos disponibles', () => {
        expect(ids(buildMenuSections(cats, [it_('1', 'a')]))).toEqual(['a']);
        expect(buildMenuSections(cats, [])).toEqual([]);
    });
    it('no muestra una categoría oculta ni sus platos', () => {
        const hidden = [cat('a', 'Fondos', 0), cat('b', 'Postres', 1, false)];
        const s = buildMenuSections(hidden, [it_('1', 'a'), it_('2', 'b')]);
        expect(ids(s)).toEqual(['a']);
        expect(s[0].items.map((i) => i.id)).toEqual(['1']);
    });
    it('is_visible nulo se trata como visible; solo false oculta', () => {
        expect(ids(buildMenuSections([cat('a', 'Fondos', 0, null)], [it_('1', 'a')]))).toEqual(['a']);
    });
    it('«Menú del día» va primero, saca sus platos de la categoría y no se duplica', () => {
        const s = buildMenuSections(cats, [it_('1', 'a', 0, { is_menu_del_dia: true }), it_('2', 'a', 1), it_('3', 'b')]);
        expect(ids(s)).toEqual([DAILY_SECTION_ID, 'a', 'b']);
        expect(s[0].kind).toBe('daily');
        expect(s[0].items.map((i) => i.id)).toEqual(['1']);
        expect(s[1].items.map((i) => i.id)).toEqual(['2']);
    });
    it('si todos los platos de una categoría son del menú del día, la categoría desaparece (queda vacía)', () => {
        expect(ids(buildMenuSections(cats, [it_('1', 'a', 0, { is_menu_del_dia: true })]))).toEqual([DAILY_SECTION_ID]);
    });
    it('un plato del menú del día en una categoría oculta tampoco se muestra', () => {
        const hidden = [cat('a', 'Fondos', 0, false)];
        expect(buildMenuSections(hidden, [it_('1', 'a', 0, { is_menu_del_dia: true })])).toEqual([]);
    });
    it('un plato sin categoría conocida va al final en «Otros»', () => {
        const s = buildMenuSections(cats, [it_('1', null), it_('2', 'no-existe'), it_('3', 'a')]);
        expect(ids(s)).toEqual(['a', OTHER_SECTION_ID]);
        expect(s[1].items.map((i) => i.id).sort()).toEqual(['1', '2']);
    });
    it('8+ categorías mantienen el orden definido', () => {
        const many = Array.from({ length: 9 }, (_, i) => cat(`c${i}`, `Cat ${i}`, 8 - i));
        const s = buildMenuSections(many, many.map((c) => it_(`p-${c.id}`, c.id)));
        expect(ids(s)).toEqual(['c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0']);
    });
    it('no muta los arreglos de entrada', () => {
        const c = [cat('b', 'B', 1), cat('a', 'A', 0)];
        const before = JSON.stringify(c);
        buildMenuSections(c, [it_('1', 'a')]);
        expect(JSON.stringify(c)).toBe(before);
    });
});
