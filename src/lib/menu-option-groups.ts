// Forma las opciones que lee la carta (filas anidadas de PostgREST) en grupos ordenados por plato. Puro, sin red.
import type { MenuOptionGroup } from "./menu-options";

export interface OptionLinkRow {
    item_id: string;
    position: number | null;
    group: {
        id: string;
        name: string;
        kind: "single" | "multiple";
        required: boolean;
        min_select: number;
        max_select: number;
        options: Array<{ id: string; name: string; price_delta: number; is_available: boolean; position: number | null }> | null;
    } | null;
}

export function shapeOptionGroups(rows: OptionLinkRow[] | null | undefined): Record<string, MenuOptionGroup[]> {
    const byItem: Record<string, Array<{ pos: number; g: MenuOptionGroup }>> = {};
    for (const r of rows ?? []) {
        if (!r.group) continue;
        const options = [...(r.group.options ?? [])]
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name, "es"))
            .map((o) => ({ id: o.id, name: o.name, price_delta: o.price_delta, is_available: o.is_available }));
        (byItem[r.item_id] ??= []).push({
            pos: r.position ?? 0,
            g: { id: r.group.id, name: r.group.name, kind: r.group.kind, required: r.group.required, min_select: r.group.min_select, max_select: r.group.max_select, options },
        });
    }
    return Object.fromEntries(Object.entries(byItem).map(([k, v]) => [k, v.sort((a, b) => a.pos - b.pos || a.g.name.localeCompare(b.g.name, "es")).map((x) => x.g)]));
}
