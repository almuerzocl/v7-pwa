import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Solo los tests unitarios de tests/. Los de migrations/tests/*.mjs usan su propio corredor (pglite).
export default defineConfig({
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    oxc: { jsx: { runtime: 'automatic' } },
    test: { include: ['tests/**/*.test.{ts,tsx}'] },
});
