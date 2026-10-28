'use client';

import { useRef } from 'react';
import { useImpression } from '@/hooks/useImpression';
import type { ClientSurface } from '@/lib/client-events';

/**
 * Elemento invisible que cubre la tarjeta del padre (que debe ser `relative`) y registra una impresión cuando la tarjeta se ve de
 * verdad. No intercepta clics ni cambia el diseño.
 */
export function ImpressionSentinel({ restaurantId, surface, position }: { restaurantId: string; surface: ClientSurface; position?: number }) {
    const ref = useRef<HTMLDivElement>(null);
    useImpression(ref, restaurantId, surface, position);
    return <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0" />;
}
