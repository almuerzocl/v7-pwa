// Líneas del carrito con opciones (reglas puras). Un mismo plato con opciones distintas son líneas distintas:
// la clave de línea es el id del plato + las opciones elegidas (ordenadas). Sin opciones, la clave es el id (carritos antiguos siguen válidos).
import type { MenuOptionGroup } from "./menu-options";

export interface SelectedOption {
    option_id: string;
    group_id: string;
    group_name: string;
    name: string;
    price_delta: number;
}

export const cartLineKey = (itemId: string, optionIds: readonly string[] = []): string =>
    optionIds.length === 0 ? itemId : `${itemId}#${[...optionIds].sort().join(",")}`;

// Snapshot de lo elegido, en el orden de los grupos y de las opciones (el mismo que deja la base en el pedido).
export function buildSelectedOptions(groups: MenuOptionGroup[], optionIds: readonly string[]): SelectedOption[] {
    const chosen = new Set(optionIds);
    const out: SelectedOption[] = [];
    for (const g of groups) {
        for (const o of g.options) {
            if (chosen.has(o.id)) out.push({ option_id: o.id, group_id: g.id, group_name: g.name, name: o.name, price_delta: o.price_delta });
        }
    }
    return out;
}

export interface LineLike {
    id: string;
    lineKey?: string;
    price: number;
    basePrice?: number;
    options?: SelectedOption[];
}

export const keyOf = (l: Pick<LineLike, "id" | "lineKey">): string => l.lineKey ?? l.id;

// Aplica las líneas corregidas que devuelve el servidor (price_mismatch): mismo plato y mismas opciones => nuevo precio y snapshot.
// Las líneas que el servidor ya no reconoce se dejan como están (el siguiente intento dirá qué pasa).
export function applyServerLines<T extends LineLike>(
    cart: T[],
    serverLines: Array<{ id?: string; options?: Array<{ option_id?: string }>; unit_price?: number; base_price?: number }>,
): T[] {
    const byKey = new Map<string, (typeof serverLines)[number]>();
    for (const s of serverLines) {
        if (typeof s.id !== "string") continue;
        byKey.set(cartLineKey(s.id, (s.options ?? []).map((o) => o.option_id ?? "").filter(Boolean)), s);
    }
    return cart.map((l) => {
        const s = byKey.get(keyOf(l));
        if (!s || typeof s.unit_price !== "number") return l;
        return { ...l, price: s.unit_price, ...(typeof s.base_price === "number" ? { basePrice: s.base_price } : {}) };
    });
}
