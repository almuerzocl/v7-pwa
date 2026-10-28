import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// Next 14 cachea sin vencimiento los fetch de supabase-js en páginas y rutas que solo exportan GET
// (incidente Cri-Olla, 2026-10-04). Ver src/lib/supabase/no-store-fetch.ts.
function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

const root = join(__dirname, '..', 'src', 'app');
const candidates = walk(root).filter((f) => /\/(route\.ts|page\.tsx)$/.test(f)).filter((f) => {
    const src = readFileSync(f, 'utf8');
    if (!/from ['"]@supabase\/supabase-js['"]/.test(src) || !/createClient/.test(src)) return false;
    if (/^['"]use client['"]/.test(src.trimStart())) return false;
    const mutates = /export (async )?function (POST|PUT|PATCH|DELETE)\b/.test(src);
    return !mutates; // las rutas con POST/PATCH/... no cachean
});

describe('clientes Supabase del servidor sin caché de datos de Next', () => {
    it('hay archivos que vigilar', () => expect(candidates.length).toBeGreaterThan(0));

    it.each(candidates.map((f) => [f.replace(root, 'src/app'), f]))('%s usa noStoreFetch y force-no-store', (_n, f) => {
        const src = readFileSync(f, 'utf8');
        expect(src).toMatch(/noStoreFetch/);
        expect(src).toMatch(/export const fetchCache = 'force-no-store'/);
    });
});
