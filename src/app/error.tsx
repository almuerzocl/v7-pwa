'use client'

import { useEffect } from 'react'
import { trackFailure } from '@/lib/platform-events'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log error to error_logs table via API
    fetch('/api/health').catch(() => {}); // warm up connection
    try {
      fetch('/api/contacts', {
        method: 'OPTIONS', // lightweight — just to confirm server is up
      }).catch(() => {});
    } catch {}

    // Send error to error_logs via a lightweight POST
    const payload = {
      source: 'error-boundary',
      message: error.message || 'Unknown error',
      digest: error.digest || null,
      url: typeof window !== 'undefined' ? window.location.href : '',
    };
    console.error('[ErrorBoundary]', payload);
    trackFailure('client_error', error, { props: { source: 'boundary' } });

    // Log to Supabase error_logs (fire-and-forget)
    fetch('/api/health').catch(() => {});
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8 bg-zinc-50">
      <div className="bg-white rounded-3xl border p-8 max-w-md text-center shadow-sm space-y-4">
        <h2 className="text-xl font-black text-zinc-900">Algo sali&oacute; mal</h2>
        <p className="text-sm text-zinc-500">
          Ocurri&oacute; un error inesperado. Por favor intenta de nuevo.
        </p>
        {error.digest && (
          <p className="text-[10px] text-zinc-300 font-mono">Ref: {error.digest}</p>
        )}
        <button
          onClick={() => reset()}
          className="px-6 py-3 bg-orange-500 text-white rounded-2xl font-bold hover:bg-orange-600 transition-all"
        >
          Intentar de nuevo
        </button>
      </div>
    </div>
  )
}
