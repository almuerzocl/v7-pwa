// Ventana en que una sesión recién iniciada puede cambiar la clave sin la actual (la usa la ruta y sus pruebas).
// Vive fuera de la ruta: Next solo admite exportar handlers y config desde un archivo route.ts.
export const RECENT_SESSION_MS = 15 * 60 * 1000;
