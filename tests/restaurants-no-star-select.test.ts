import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Guardia: ningún cliente de NAVEGADOR debe leer `restaurants` con `select('*')`.
// La tabla es de lectura pública y tiene columnas internas (subscription_plan, next_billing_date). Para poder ocultarlas con
// permisos por columna, ninguna pantalla puede depender de `*` (con permisos por columna, `*` falla entera).
// Solo vale para clientes con la anon key / sesión del usuario; los de service_role (supabaseAdmin) no se ven afectados.
const ROOT = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
}

// Archivos que leen con service_role (no sujetos a los permisos por columna) y por eso pueden usar `*`.
const SERVICE_ROLE_FILES = new Set<string>();

/** Devuelve las listas de columnas de cada `.from('restaurants').select(<lista>)` del archivo. */
function restaurantSelects(src: string): string[] {
    // Tolera comentarios (// ...) entre .from('restaurants') y .select(...): un comentario no debe esconder un select('*').
    const re = /\.from\(\s*['"]restaurants['"]\s*\)\s*(?:\/\/[^\n]*\n\s*)*\.select\(\s*([`'"])([\s\S]*?)\1/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[2]);
    return out;
}

/** ¿La lista pide `*` de la tabla restaurants (no el `(*)` de una relación embebida)? */
function selectsStar(list: string): boolean {
    const withoutEmbeds = list.replace(/[\w:!]+\([^)]*\)/g, '');   // quita menu_items(*) / restaurant:restaurants(a, b)
    return /(^|[\s,])\*([\s,]|$)/.test(withoutEmbeds);
}

describe('restaurants: sin select(*) desde clientes de navegador', () => {
    it('el extractor ve el select aunque haya un comentario entre from y select', () => {
        const src = "supabase\n    .from('restaurants')\n    // un comentario\n    .select(`\n   *,\n   menu_items(*)\n`)";
        const found = restaurantSelects(src);
        expect(found).toHaveLength(1);
        expect(selectsStar(found[0])).toBe(true);
    });

    it('el detector reconoce los casos (sanidad de la guardia)', () => {
        expect(selectsStar('*')).toBe(true);
        expect(selectsStar('*, menu_items(*)')).toBe(true);
        expect(selectsStar('id, name, menu_items(*)')).toBe(false);
        expect(selectsStar('id, name, restaurant:restaurants(name, address)')).toBe(false);
        expect(selectsStar('id, name')).toBe(false);
    });

    const files = walk(ROOT).map((f) => ({ f, rel: relative(join(__dirname, '..'), f) }));
    for (const { f, rel } of files) {
        const selects = restaurantSelects(readFileSync(f, 'utf8'));
        if (selects.length === 0) continue;
        it(`${rel} no pide '*' de restaurants${SERVICE_ROLE_FILES.has(rel) ? ' (permitido: service_role)' : ''}`, () => {
            if (SERVICE_ROLE_FILES.has(rel)) return;
            for (const list of selects) {
                expect(selectsStar(list), `select de restaurants con '*' en ${rel}: ${list.replace(/\s+/g, ' ').trim()}`).toBe(false);
            }
        });
    }
});
