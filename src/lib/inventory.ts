// MODULO DE INVENTARIO (PWA): unica puerta de la PWA a menu_items y al stock.
// La PWA NO calcula ni descuenta stock: el descuento/devolucion lo hace la base (migracion 008) y la
// verificacion previa aqui es solo UX. La garantia real contra sobreventa es el guard de la base,
// que rechaza el INSERT del pedido con 'SIN_STOCK|<producto>|<disponible>'.
import type { SupabaseClient } from "@supabase/supabase-js";
import { shapeOptionGroups, type OptionLinkRow } from "./menu-option-groups";
import type { MenuOptionGroup } from "./menu-options";

export interface StockShortage {
    id: string;
    name: string;
    requested: number;
    available: number;
}

// Fragmentos de select para embeber el menu en consultas de restaurants (el nombre de la tabla vive solo aqui).
export const DAILY_MENU_EMBED = "menu_items(id, name, description, price, image_url, is_menu_del_dia)";
export const ALL_MENU_EMBED = "menu_items(*)";
export const DAILY_MENU_FILTER_COLUMN = "menu_items.is_menu_del_dia";

export function extractDailyMenus(restaurant: any) {
    return (restaurant?.menu_items || [])
        .filter((m: any) => m.is_menu_del_dia)
        .map((m: any) => ({ ...m, imageUrl: m.image_url }));
}

export function extractMenuNames(restaurant: any, limit = 6): string[] {
    return (restaurant?.menu_items || []).slice(0, limit).map((m: any) => m.name);
}

export async function getAvailableMenuItems(client: SupabaseClient<any, any, any>, restaurantId: string) {
    return client
        .from("menu_items")
        .select("id, name, description, price, takeaway_price, image_url, category, category_id, position, is_menu_del_dia")
        .eq("restaurant_id", restaurantId)
        .eq("is_available", true);
}

// Categorías de la carta (migración 046): la PWA decide qué secciones mostrar con buildMenuSections (lib/menu-sections.ts).
export async function getMenuCategories(client: SupabaseClient<any, any, any>, restaurantId: string) {
    return client
        .from("menu_categories")
        .select("id, name, position, is_visible")
        .eq("restaurant_id", restaurantId)
        .order("position");
}

// Grupos de opciones de los platos (migración 047), ya ordenados: Record<plato, grupos[]>. Un fallo de lectura no tumba la carta:
// los platos se muestran sin opciones solo si NO tienen grupos; aquí se devuelve vacío y el llamador decide.
export async function getOptionGroupsByItem(client: SupabaseClient<any, any, any>, itemIds: string[]) {
    if (itemIds.length === 0) return { data: {} as Record<string, MenuOptionGroup[]>, error: null };
    const { data, error } = await client
        .from("menu_item_option_groups")
        .select("item_id, position, group:menu_option_groups(id, name, kind, required, min_select, max_select, options:menu_options(id, name, price_delta, is_available, position))")
        .in("item_id", itemIds);
    return { data: shapeOptionGroups(data as OptionLinkRow[] | null), error };
}

// Lee el stock real del servidor (via RPC) y devuelve los items que no alcanzan.
export async function checkAvailability(
    client: SupabaseClient<any, any, any>,
    items: { id: string; quantity: number }[]
): Promise<StockShortage[]> {
    const { data, error } = await client.rpc("inventory_check_availability", {
        p_items: items.map((i) => ({ id: i.id, quantity: i.quantity })),
    });
    if (error) throw error;
    return (data as StockShortage[]) || [];
}

export function formatShortage(s: StockShortage): string {
    return s.available === 0
        ? `"${s.name}" está agotado. Quítalo del pedido para continuar.`
        : `No hay stock suficiente de "${s.name}". Máximo disponible: ${s.available}.`;
}

// Traduce el rechazo del guard de la base (SQLSTATE INV01) a un mensaje de usuario; null si es otro error.
export function parseStockError(err: unknown): string | null {
    const msg = (err as any)?.message;
    if (typeof msg !== "string") return null;
    const m = /SIN_STOCK\|([^|]*)\|(\d+)/.exec(msg);
    if (!m) return null;
    return formatShortage({ id: "", name: m[1], requested: 0, available: Number(m[2]) });
}
