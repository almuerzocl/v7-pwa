'use client';

import { useEffect, useState } from 'react';
import { GoogleAnalytics } from '@next/third-parties/google';
import { CONSENT_EVENT, analyticsAllowed, readConsent } from '@/lib/cookie-consent';

export default function ConsentAnalytics({ gaId }: { gaId: string }) {
    const [allowed, setAllowed] = useState(false);

    useEffect(() => {
        const sync = () => {
            let storage: Storage | null = null;
            try { storage = window.localStorage; } catch { storage = null; }
            setAllowed(analyticsAllowed(readConsent(storage)));
        };
        sync();
        window.addEventListener(CONSENT_EVENT, sync);
        window.addEventListener('storage', sync);
        return () => {
            window.removeEventListener(CONSENT_EVENT, sync);
            window.removeEventListener('storage', sync);
        };
    }, []);

    return allowed ? <GoogleAnalytics gaId={gaId} /> : null;
}
