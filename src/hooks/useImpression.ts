'use client';

import { useEffect, type RefObject } from 'react';
import { trackImpression, type ClientSurface } from '@/lib/client-events';

/**
 * Registra una impresión cuando el elemento estuvo visible al menos la mitad durante 600 ms (no cuenta lo que solo pasa de largo
 * al hacer scroll). Una vez por sesión, local y superficie.
 */
export function useImpression(ref: RefObject<Element | null>, restaurantId: string | undefined, surface: ClientSurface, position?: number) {
    useEffect(() => {
        const el = ref.current;
        if (!el || !restaurantId || typeof IntersectionObserver === 'undefined') return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                    if (timer == null) {
                        timer = setTimeout(() => { trackImpression(restaurantId, surface, position); observer.disconnect(); }, 600);
                    }
                } else if (timer != null) {
                    clearTimeout(timer);
                    timer = null;
                }
            }
        }, { threshold: [0, 0.5, 1] });
        observer.observe(el);
        return () => { if (timer != null) clearTimeout(timer); observer.disconnect(); };
    }, [ref, restaurantId, surface, position]);
}
