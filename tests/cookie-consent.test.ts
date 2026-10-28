import { describe, expect, it } from 'vitest';
import { analyticsAllowed, readConsent } from '../src/lib/cookie-consent';

const store = (v: string | null) => ({ getItem: () => v });

describe('cookie-consent', () => {
    it('solo "accepted" permite analíticas', () => {
        expect(analyticsAllowed(readConsent(store('accepted')))).toBe(true);
        expect(analyticsAllowed(readConsent(store('essential-only')))).toBe(false);
    });
    it('sin elección, valor raro o sin almacenamiento: no se cargan', () => {
        expect(analyticsAllowed(readConsent(store(null)))).toBe(false);
        expect(analyticsAllowed(readConsent(store('yes')))).toBe(false);
        expect(analyticsAllowed(readConsent(null))).toBe(false);
        expect(analyticsAllowed(readConsent({ getItem: () => { throw new Error('x'); } }))).toBe(false);
    });
});
