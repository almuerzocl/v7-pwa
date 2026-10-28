import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Un local sin cupo en su plan (tope alcanzado o sin vigencia) no aparece en los listados de la PWA (migración 039).
// Los interruptores del dueño no se modifican: la visibilidad efectiva es el interruptor Y el estado del plan.
// Esta guardia falla si un listado deja de filtrar `plan_hidden`; si se agrega un listado nuevo, súmalo aquí.
const LISTINGS = [
    'src/app/(main)/page.tsx',
    'src/app/(main)/HomeClient.tsx',
    'src/app/(main)/favorites/page.tsx',
    'src/lib/olivia/snapshots.ts',
];

describe('listados de locales ocultan los que el plan bloquea', () => {
    for (const file of LISTINGS) {
        it(`${file} filtra plan_hidden`, () => {
            const src = readFileSync(join(__dirname, '..', file), 'utf8');
            expect(src).toMatch(/\.eq\('plan_hidden', false\)/);
        });
    }

    it('la ficha del local se puede ver pero no reservar ni pedir', () => {
        const detail = readFileSync(join(__dirname, '..', 'src/app/(main)/restaurant/[id]/RestaurantDetailClient.tsx'), 'utf8');
        expect(detail).toMatch(/plan_hidden === true/);
        expect(detail).toMatch(/disabled=\{!canReserve\}/);
        expect(detail).toMatch(/disabled=\{!canOrder\}/);
        const page = readFileSync(join(__dirname, '..', 'src/app/(main)/restaurant/[id]/page.tsx'), 'utf8');
        expect(page).toMatch(/plan_hidden/);
    });
});
