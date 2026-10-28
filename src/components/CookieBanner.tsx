'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CONSENT_EVENT, CONSENT_KEY, type ConsentChoice } from '@/lib/cookie-consent';

const STORAGE_KEY = CONSENT_KEY;

export default function CookieBanner() {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        try {
            if (typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === null) {
                setVisible(true);
            }
        } catch {
            // localStorage unavailable (private mode, SSR) — skip silently
        }
    }, []);

    const choose = (value: ConsentChoice) => {
        try {
            localStorage.setItem(STORAGE_KEY, value);
            window.dispatchEvent(new Event(CONSENT_EVENT));
        } catch {
            // ignore
        }
        setVisible(false);
    };

    if (!visible) return null;

    return (
        <div
            role="dialog"
            aria-live="polite"
            aria-label="Aviso de cookies"
            className="fixed inset-x-0 bottom-0 z-[10000] px-4 pb-4 sm:px-6 sm:pb-6"
        >
            <div className="mx-auto max-w-3xl rounded-2xl border border-zinc-200 bg-white/95 shadow-xl backdrop-blur p-5 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-zinc-700 leading-relaxed">
                        Usamos cookies para mejorar tu experiencia. Las esenciales son necesarias para el funcionamiento del sitio; las analíticas son opcionales. Revisa nuestra{' '}
                        <Link href="/cookies" className="text-orange-600 font-bold underline">
                            Política de Cookies
                        </Link>
                        .
                    </p>
                    <div className="flex gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={() => choose('essential-only')}
                            className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-bold text-zinc-700 hover:bg-zinc-100 transition"
                        >
                            Rechazar opcionales
                        </button>
                        <button
                            type="button"
                            onClick={() => choose('accepted')}
                            className="rounded-full bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-700 transition"
                        >
                            Aceptar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
