import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { noStoreFetch } from "@/lib/supabase/no-store-fetch";
import { notFound } from "next/navigation";
import MenuClient from "./MenuClient";
import { getAvailableMenuItems, getMenuCategories, getOptionGroupsByItem } from "@/lib/inventory";

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

let _admin: SupabaseClient<any> | null = null;
function supabaseAdmin() {
    if (!_admin) {
        _admin = createClient<any>(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { global: { fetch: noStoreFetch } }
        );
    }
    return _admin;
}

interface Props {
    params: { id: string };
}

export default async function RestaurantMenuPage({ params }: Props) {
    const [resResult, menuResult, categoriesResult] = await Promise.all([
        supabaseAdmin()
            .from('restaurants')
            .select('id, name, logo_url, cover_image_url, has_takeaway')
            .eq('id', params.id)
            .single(),
        getAvailableMenuItems(supabaseAdmin(), params.id),
        getMenuCategories(supabaseAdmin(), params.id)
    ]);

    if (!resResult.data) notFound();

    // Opciones de los platos. Si no se pueden leer, un plato CON grupos nunca se ofrece como si no los tuviera (precio incompleto):
    // se falla la carta en vez de mostrarla sin opciones.
    const items = menuResult.data || [];
    const { data: optionGroups, error: optionsError } = await getOptionGroupsByItem(supabaseAdmin(), items.map((i: { id: string }) => i.id));
    if (optionsError) throw new Error(`No se pudieron leer las opciones de la carta: ${optionsError.message}`);

    return <MenuClient restaurant={resResult.data} menuItems={items} categories={categoriesResult.data || []} optionGroups={optionGroups} />;
}
