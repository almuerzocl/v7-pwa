import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ profile: null, user: null, refreshProfile: () => {} }) }));
vi.mock('@/app/actions/profile-actions', () => ({ toggleFavoriteAction: vi.fn(), toggleSubscriptionAction: vi.fn() }));
vi.mock('@/components/blocks/ImpressionSentinel', () => ({ ImpressionSentinel: () => null }));
vi.mock('next/image', () => ({ default: () => null }));

import { RestaurantCard } from '@/components/blocks/RestaurantCard';

const base: any = {
    id: 'r1', name: 'Cri-Olla', description: 'x', cuisineType: 'Chilena', priceLevel: 2, address: 'a', comuna: 'c',
    hasReservations: true, hasTakeaway: true, isSponsored: false, isFeatured: false, isActive: true,
};

describe('RestaurantCard: campana de suscripción', () => {
    it('se ve aunque hoy no haya menú del día', () => {
        for (const dailyMenus of [undefined, [], [{ id: 'm' }]]) {
            const html = renderToStaticMarkup(<RestaurantCard restaurant={{ ...base, dailyMenus }} />);
            expect(html).toContain('lucide-heart');
            expect(html).toContain('lucide-bell');
        }
    });
    it('local cerrado no muestra botones', () => {
        const html = renderToStaticMarkup(<RestaurantCard restaurant={{ ...base, isActive: false }} />);
        expect(html).not.toContain('lucide-bell');
    });
});
