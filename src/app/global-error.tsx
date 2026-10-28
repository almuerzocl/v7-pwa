'use client'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="es">
      <body>
        <div style={{ display: 'flex', minHeight: '100vh', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '1rem' }}>Algo salió mal</h2>
          <p style={{ color: '#666', marginBottom: '1.5rem', textAlign: 'center', maxWidth: '28rem' }}>
            Ocurrió un error inesperado. Por favor intenta de nuevo.
          </p>
          <button
            onClick={() => reset()}
            style={{ padding: '0.5rem 1rem', backgroundColor: '#000', color: '#fff', borderRadius: '0.375rem', border: 'none', cursor: 'pointer' }}
          >
            Intentar de nuevo
          </button>
        </div>
      </body>
    </html>
  )
}
