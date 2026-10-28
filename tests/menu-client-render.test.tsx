import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ back: () => {}, push: () => {} }) }));
vi.mock('@/context/CartContext', () => ({ useCart: () => ({ addToCart: () => {}, itemCount: 0 }) }));
vi.mock('@/lib/client-events', () => ({ trackClientEvent: () => {} }));

import MenuClient from '@/app/(main)/restaurant/[id]/menu/MenuClient';

const restaurant = { id: 'r1', name: 'Cri-Olla', has_takeaway: true };
const item = (id: string, category_id: string | null, extra: Record<string, unknown> = {}) =>
    ({ id, name: `Plato ${id}`, price: 5000, takeaway_price: 5000, category: 'x', category_id, position: 0, ...extra });
const cats = [{ id: 'c1', name: 'Fondos', position: 1, is_visible: true }, { id: 'c2', name: 'Postres', position: 0, is_visible: true }];
const html = (items: any[], categories: any[] = cats) => renderToStaticMarkup(<MenuClient restaurant={restaurant} menuItems={items} categories={categories} />);

describe('carta de la PWA por categorías', () => {
    it('muestra una sección con título por categoría, en el orden del restaurante, y chips para navegar', () => {
        const h = html([item('1', 'c1'), item('2', 'c2')]);
        expect(h).toContain('aria-label="Categorías de la carta"');
        expect(h.indexOf('data-chip-id="c2"')).toBeLessThan(h.indexOf('data-chip-id="c1"'));
        expect(h).toContain('id="seccion-c1"');
        expect(h).toMatch(/Postres[\s\S]*Fondos/);
    });
    it('el primer chip nace activo (aria-current) y solo uno', () => {
        const h = html([item('1', 'c1'), item('2', 'c2')]);
        expect((h.match(/aria-current="true"/g) ?? []).length).toBe(1);
        expect(h).toMatch(/data-chip-id="c2"[^>]*aria-current="true"|aria-current="true"[^>]*data-chip-id="c2"/);
    });
    it('con una sola sección no muestra barra de chips', () => {
        expect(html([item('1', 'c1')])).not.toContain('Categorías de la carta');
    });
    it('«Menú del día» abre la carta y no se repite en su categoría', () => {
        const h = html([item('1', 'c1', { is_menu_del_dia: true }), item('2', 'c1')]);
        expect(h.indexOf('data-chip-id="menu-del-dia"')).toBeLessThan(h.indexOf('data-chip-id="c1"'));
        expect((h.match(/Plato 1</g) ?? []).length).toBe(1);
    });
    it('una categoría oculta no aparece; sin platos queda el aviso', () => {
        const h = html([item('1', 'c1')], [{ id: 'c1', name: 'Fondos', position: 0, is_visible: false }]);
        expect(h).not.toContain('Fondos');
        expect(h).toContain('Menú no detallado');
    });
});
