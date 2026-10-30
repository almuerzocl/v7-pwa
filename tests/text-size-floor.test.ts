import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Guía de diseño (accesibilidad): ningún texto por debajo de 12 px. Usar `text-xs` o mayor.
// TicketDigital.view.tsx es idéntico en tres repos y se cambia en bloque aparte.
const EXCEPT = new Set(["TicketDigital.view.tsx"]);

function walk(dir: string, out: string[] = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(tsx|ts)$/.test(name) && !EXCEPT.has(name)) out.push(p);
    }
    return out;
}

describe("piso de tamaño de texto", () => {
    it("no hay text-[Npx] con N < 12 en src/", () => {
        const offenders = walk(join(process.cwd(), "src")).filter((f) => /text-\[(?:[0-9]|1[01])(?:\.[0-9]+)?px\]/.test(readFileSync(f, "utf8")));
        expect(offenders).toEqual([]);
    });
});
