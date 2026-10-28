// Secciones de la carta del cliente (reglas puras, sin red ni React).
//  - «Menú del día» es una sección ESPECIAL fija arriba: junta los platos con is_menu_del_dia y los saca de su categoría
//    (así no aparecen dos veces). Su lógica de disponibilidad no cambia: llegan solo los platos disponibles.
//  - Cada categoría es una sección en el orden que define el restaurante (position); los platos, también por position.
//  - Una categoría oculta (is_visible = false) NO se muestra, y sus platos tampoco (ni siquiera en «Menú del día»).
//  - Una categoría sin platos disponibles no se muestra.
//  - Un plato sin categoría conocida (no debería ocurrir tras la migración 046) va al final, en «Otros».

export interface MenuCategoryRow {
    id: string;
    name: string;
    position: number | null;
    is_visible: boolean | null;
}

export interface MenuSectionItem {
    id: string;
    name: string;
    category_id?: string | null;
    position?: number | null;
    is_menu_del_dia?: boolean | null;
    [k: string]: unknown;
}

export interface MenuSection<T extends MenuSectionItem = MenuSectionItem> {
    /** Id estable para el ancla (#seccion-<id>). */
    id: string;
    name: string;
    kind: "daily" | "category" | "other";
    items: T[];
}

export const DAILY_SECTION_ID = "menu-del-dia";
export const OTHER_SECTION_ID = "otros";

const byPosition = <T extends { position?: number | null; name: string }>(a: T, b: T) =>
    (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name, "es");

export function buildMenuSections<T extends MenuSectionItem>(categories: MenuCategoryRow[], items: T[]): MenuSection<T>[] {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const hidden = new Set(categories.filter((c) => c.is_visible === false).map((c) => c.id));

    const shown = items.filter((i) => !(i.category_id && hidden.has(i.category_id)));
    const daily = shown.filter((i) => i.is_menu_del_dia);
    const regular = shown.filter((i) => !i.is_menu_del_dia);

    const sections: MenuSection<T>[] = [];
    if (daily.length > 0) sections.push({ id: DAILY_SECTION_ID, name: "Menú del día", kind: "daily", items: [...daily].sort(byPosition) });

    for (const c of [...categories].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name, "es"))) {
        if (c.is_visible === false) continue;
        const list = regular.filter((i) => i.category_id === c.id);
        if (list.length > 0) sections.push({ id: c.id, name: c.name, kind: "category", items: [...list].sort(byPosition) });
    }

    const orphans = regular.filter((i) => !i.category_id || !byId.has(i.category_id));
    if (orphans.length > 0) sections.push({ id: OTHER_SECTION_ID, name: "Otros", kind: "other", items: [...orphans].sort(byPosition) });
    return sections;
}
