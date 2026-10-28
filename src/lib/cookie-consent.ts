// Elección del aviso de cookies. Las analíticas de terceros (Google Analytics) solo se cargan con 'accepted'.
export const CONSENT_KEY = 'cookie-consent';
export const CONSENT_EVENT = 'cookie-consent-change';

export type ConsentChoice = 'accepted' | 'essential-only';

export function readConsent(storage: Pick<Storage, 'getItem'> | null): ConsentChoice | null {
    try {
        const v = storage?.getItem(CONSENT_KEY);
        return v === 'accepted' || v === 'essential-only' ? v : null;
    } catch {
        return null;
    }
}

/** Sin elección, sin almacenamiento o ante cualquier duda: no se cargan analíticas. */
export function analyticsAllowed(choice: ConsentChoice | null): boolean {
    return choice === 'accepted';
}
