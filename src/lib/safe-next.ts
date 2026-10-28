// Sin dependencias de servidor: lo usan el servidor (magic-link.ts) y la página /auth/ingresar (navegador).

/** Solo rutas internas (nada de //host ni esquemas): el `next` viaja por el correo y no debe servir para redirigir fuera. */
export function safeNext(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 500) return '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return '/';
    if (raw.startsWith('/login') || raw.startsWith('/auth/')) return '/';
    return raw;
}
