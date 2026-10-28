// Opciones y extras de un plato (reglas puras, sin red ni React). ARCHIVO IDÉNTICO en pwa y restaurant-dashboard (verificar con cmp).
// La verdad del precio la recalcula la base (trigger takeaway_price_guard, migración 047): esto es la misma regla para validar
// la configuración en el editor y mostrar el precio vivo en el selector. Hay una prueba de paridad TS <-> SQL.

export type GroupKind = "single" | "multiple";

export interface MenuOption {
    id: string;
    name: string;
    price_delta: number;
    is_available: boolean;
}

export interface MenuOptionGroup {
    id: string;
    name: string;
    kind: GroupKind;
    required: boolean;
    min_select: number;
    max_select: number;
    options: MenuOption[];
}

export const MAX_NAME = 60;
export const MAX_DELTA = 1_000_000;
export const MAX_GROUP_SELECT = 20;
export const MAX_QUANTITY = 100;

export interface GroupConfig {
    kind: GroupKind;
    required: boolean;
    min_select: number;
    max_select: number;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

// Lleva una configuración "como la pide el formulario" a una consistente con los CHECK de la base:
//  - una: máximo 1; obligatoria => mínimo 1.
//  - varias: el mínimo manda; obligatoria <=> mínimo >= 1 (marcar obligatorio sube el mínimo a 1).
export function normalizeGroupConfig(input: GroupConfig): GroupConfig {
    if (input.kind === "single") {
        return { kind: "single", required: input.required, min_select: input.required ? 1 : 0, max_select: 1 };
    }
    const min = input.required ? Math.max(1, input.min_select) : input.min_select >= 1 ? input.min_select : 0;
    return { kind: "multiple", required: min >= 1, min_select: min, max_select: input.max_select };
}

// Error en español o null. Valida lo mismo que los CHECK de menu_option_groups.
export function validateGroupConfig(c: GroupConfig): string | null {
    if (c.kind !== "single" && c.kind !== "multiple") return "El tipo debe ser «elegir una» o «elegir varias»";
    if (!isInt(c.min_select) || !isInt(c.max_select)) return "El mínimo y el máximo deben ser números enteros";
    if (c.min_select < 0) return "El mínimo no puede ser negativo";
    if (c.max_select < 1) return "El máximo debe ser al menos 1";
    if (c.max_select > MAX_GROUP_SELECT) return `El máximo admite hasta ${MAX_GROUP_SELECT}`;
    if (c.min_select > c.max_select) return "El mínimo no puede ser mayor que el máximo";
    if (c.kind === "single" && c.max_select !== 1) return "Elegir una opción implica máximo 1";
    if (c.required !== c.min_select >= 1) return "Obligatorio equivale a un mínimo de 1 o más";
    return null;
}

export function validateOptionName(name: unknown): string | null {
    if (typeof name !== "string" || !name.trim()) return "Escribe el nombre";
    if (name.trim().length > MAX_NAME) return `El nombre admite hasta ${MAX_NAME} caracteres`;
    return null;
}

export function validatePriceDelta(v: unknown): string | null {
    if (!isInt(v) || v < 0 || v > MAX_DELTA) return `El recargo debe ser un entero entre 0 y ${MAX_DELTA.toLocaleString("es-CL")} (0 = sin costo)`;
    return null;
}

// Un grupo obligatorio sin opciones disponibles suficientes bloquea el plato: se avisa en el editor.
export function groupUnsatisfiable(g: Pick<MenuOptionGroup, "min_select" | "options">): boolean {
    return g.min_select > g.options.filter((o) => o.is_available).length;
}

// Precio base de un plato para llevar: igual que la PWA y el pedido manual (takeaway_price 0 o vacío = precio local).
export function baseUnitPrice(item: { price: number; takeaway_price?: number | null }): number {
    return item.takeaway_price && item.takeaway_price > 0 ? item.takeaway_price : item.price;
}

export type SelectionErrorCode = "option_duplicate" | "option_invalid" | "option_unavailable" | "option_max" | "option_min";

export interface SelectionError {
    code: SelectionErrorCode;
    message: string;
}

// Valida las opciones elegidas para un plato con los grupos que tiene asignados (en orden). Mismo orden de chequeos que la base:
// repetidas, luego cada opción (del plato, disponible) en el orden elegido, luego máximo y mínimo por grupo.
export function validateSelection(groups: MenuOptionGroup[], selectedIds: string[]): SelectionError | null {
    const seen = new Set<string>();
    for (const id of selectedIds) {
        if (seen.has(id)) return { code: "option_duplicate", message: "Elegiste dos veces la misma opción" };
        seen.add(id);
    }
    const byId = new Map<string, MenuOption>();
    for (const g of groups) for (const o of g.options) byId.set(o.id, o);
    for (const id of selectedIds) {
        const o = byId.get(id);
        if (!o) return { code: "option_invalid", message: "Una opción elegida no corresponde a este plato" };
        if (!o.is_available) return { code: "option_unavailable", message: `La opción «${o.name}» ya no está disponible` };
    }
    for (const g of groups) {
        const n = g.options.filter((o) => seen.has(o.id)).length;
        if (n > g.max_select) return { code: "option_max", message: `En «${g.name}» puedes elegir hasta ${g.max_select}` };
        if (n < g.min_select) return { code: "option_min", message: `En «${g.name}» debes elegir al menos ${g.min_select}` };
    }
    return null;
}

// Precio unitario final: base + recargos de lo elegido. Asume una selección válida.
export function unitPrice(base: number, groups: MenuOptionGroup[], selectedIds: string[]): number {
    const sel = new Set(selectedIds);
    let total = base;
    for (const g of groups) for (const o of g.options) if (sel.has(o.id)) total += o.price_delta;
    return total;
}

export const lineTotal = (unit: number, quantity: number) => unit * quantity;

export function orderTotal(lines: Array<{ unit_price: number; quantity: number }>): number {
    return lines.reduce((s, l) => s + lineTotal(l.unit_price, l.quantity), 0);
}

// Texto corto para ticket, comanda, correo y tablero: «Papas fritas, Sin ají».
export function optionsSummary(options: Array<{ name: string }> | null | undefined): string {
    return (options ?? []).map((o) => o.name).join(", ");
}
