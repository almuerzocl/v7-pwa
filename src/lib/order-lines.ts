// Líneas legibles de un pedido (con las opciones elegidas) para tablero, lista, comanda y correos. ARCHIVO IDÉNTICO en pwa y
// restaurant-dashboard (verificar con cmp). `items` llega como arreglo, texto JSON o nulo; las opciones son el snapshot del pedido
// (nombre y recargo del momento en que se pidió), nunca una referencia viva al menú.

export interface OrderLine {
    quantity: number;
    name: string;
    options: string[];
}

export function parseOrderLines(items: unknown): OrderLine[] {
    let list: unknown = items;
    if (typeof list === "string") { try { list = JSON.parse(list); } catch { return []; } }
    if (!Array.isArray(list)) return [];
    return list
        .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
        .map((i) => {
            const q = Number(i.quantity);
            const opts = Array.isArray(i.options) ? i.options : [];
            return {
                quantity: Number.isFinite(q) && q > 0 ? Math.floor(q) : 1,
                name: typeof i.name === "string" && i.name.trim() ? i.name : "Plato",
                options: opts
                    .map((o) => (o && typeof o === "object" ? (o as { name?: unknown }).name : null))
                    .filter((n): n is string => typeof n === "string" && n.trim() !== ""),
            };
        });
}

export const hasOptions = (lines: OrderLine[]): boolean => lines.some((l) => l.options.length > 0);
