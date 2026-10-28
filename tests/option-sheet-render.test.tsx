import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// El diálogo de Radix usa un portal (no existe en render de servidor): se sustituye por envoltorios simples para ver el contenido.
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
    DialogContent: ({ children }: any) => <div role="dialog">{children}</div>,
    DialogTitle: ({ children }: any) => <h2>{children}</h2>,
    DialogDescription: ({ children }: any) => <p>{children}</p>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: () => {}, push: () => {} }) }));
vi.mock('@/context/CartContext', () => ({ useCart: () => ({ addToCart: () => {}, itemCount: 0 }) }));
vi.mock('@/lib/client-events', () => ({ trackClientEvent: () => {} }));

import { OptionSheet } from '@/components/menu/OptionSheet';
import MenuClient from '@/app/(main)/restaurant/[id]/menu/MenuClient';
import type { MenuOptionGroup } from '@/lib/menu-options';

const groups: MenuOptionGroup[] = [
    { id: 'g1', name: 'Acompañamiento', kind: 'single', required: true, min_select: 1, max_select: 1, options: [
        { id: 'papas', name: 'Papas fritas', price_delta: 0, is_available: true }, { id: 'ens', name: 'Ensalada', price_delta: 500, is_available: false }] },
    { id: 'g2', name: 'Agregados', kind: 'multiple', required: false, min_select: 0, max_select: 2, options: [
        { id: 'queso', name: 'Queso', price_delta: 800, is_available: true }] },
    { id: 'g3', name: 'Punto', kind: 'single', required: false, min_select: 0, max_select: 1, options: [{ id: 'medio', name: 'Medio', price_delta: 0, is_available: true }] },
];
const sheet = () => renderToStaticMarkup(<OptionSheet open name="Pastel de choclo" basePrice={6500} groups={groups} onClose={() => {}} onAdd={() => {}} />);

describe('hoja de opciones', () => {
    it('muestra título, grupos con leyenda, obligatorio/opcional y la pista de cuántas elegir', () => {
        const h = sheet();
        expect(h).toContain('Pastel de choclo');
        expect(h).toContain('<legend');
        expect(h).toContain('Obligatorio');
        expect(h).toContain('Elige 1');
        expect(h).toContain('Elige hasta 2');
    });
    it('«una» usa radios, «varias» casillas, y un grupo opcional de una ofrece «Sin …»', () => {
        const h = sheet();
        expect((h.match(/type="radio"/g) ?? []).length).toBe(4); // papas, ensalada, medio, «Sin punto»
        expect(h).toContain('type="checkbox"');
        expect(h).toContain('Sin punto');
        expect(h).not.toContain('Sin acompañamiento'); // el obligatorio no tiene «sin»
    });
    it('la opción apagada se ve pero deshabilitada y rotulada; el recargo se muestra', () => {
        const h = sheet();
        expect(h).toMatch(/disabled=""[^>]*\/?>[\s\S]{0,200}Ensalada/);
        expect(h).toContain('No disponible');
        expect(h).toContain('+$800');
    });
    it('el precio inicial es el base y la cantidad es 1; botones con 44 px y etiquetas', () => {
        const h = sheet();
        expect(h).toContain('$6.500');
        expect(h).toContain('aria-label="Menos"');
        expect(h).toContain('aria-label="Más"');
        expect(h).toContain('h-11 w-11');
    });
    it('cerrada no renderiza nada', () => {
        expect(renderToStaticMarkup(<OptionSheet open={false} name="x" basePrice={1} groups={groups} onClose={() => {}} onAdd={() => {}} />)).toBe('');
    });
});

describe('carta con platos con opciones', () => {
    const restaurant = { id: 'r1', name: 'Cri-Olla', has_takeaway: true };
    const item = (id: string) => ({ id, name: `Plato ${id}`, price: 6900, takeaway_price: 6500, category: 'x', category_id: 'c1', position: 0 });
    const cats = [{ id: 'c1', name: 'Fondos', position: 0, is_visible: true }];
    const html = (og: Record<string, MenuOptionGroup[]>) => renderToStaticMarkup(<MenuClient restaurant={restaurant} menuItems={[item('a'), item('b')]} categories={cats} optionGroups={og} />);

    it('un plato con grupos dice «Con opciones» y su botón avisa que abre opciones; el otro agrega directo', () => {
        const h = html({ a: groups });
        expect(h).toContain('Con opciones');
        expect(h).toContain('aria-label="Elegir opciones de Plato a"');
        expect(h).toContain('aria-label="Agregar Plato b"');
    });
    it('si un grupo obligatorio no se puede cumplir (todo apagado) el plato no se puede pedir', () => {
        const dead: MenuOptionGroup[] = [{ id: 'g', name: 'Acomp', kind: 'single', required: true, min_select: 1, max_select: 1, options: [{ id: 'x', name: 'X', price_delta: 0, is_available: false }] }];
        const h = html({ a: dead });
        expect(h).toContain('No disponible por ahora');
        expect(h).not.toContain('aria-label="Elegir opciones de Plato a"');
    });
});
