import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { noStoreFetch } from "@/lib/supabase/no-store-fetch";
import HomeClient from "./HomeClient";
import { OliviaLauncher } from "@/components/olivia/OliviaLauncher";
import { DAILY_MENU_EMBED, DAILY_MENU_FILTER_COLUMN, extractDailyMenus } from "@/lib/inventory";

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// Use admin client for public restaurant data — works without user session
let _supabaseAdmin: SupabaseClient<any> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient<any>(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { global: { fetch: noStoreFetch } }
        );
    }
    return _supabaseAdmin;
}

// OlivIA se muestra solo si el interruptor de la base está encendido (olivia_config.enabled). Cualquier falla (p. ej. la migración 043
// aún sin aplicar) la deja apagada: la portada queda idéntica a la de antes.
async function isOliviaEnabled(): Promise<boolean> {
    try {
        const { data, error } = await supabaseAdmin().from('olivia_config').select('enabled').maybeSingle();
        return !error && data?.enabled === true;
    } catch {
        return false;
    }
}

export default async function Page() {
    const oliviaOn = await isOliviaEnabled();
    const { data, error } = await supabaseAdmin()
        .from('restaurants')
        .select(`
            id, name, description, logo_url, cover_image_url, cuisine_type, price_level,
            address, comuna, phone, has_reservations, has_takeaway, average_prep_time,
            is_sponsored, is_featured, is_active,
            ${DAILY_MENU_EMBED}
        `)
        .eq('is_active', true)
        .eq('plan_hidden', false) // sin cupo en su plan: no aparece en el listado
        .eq(DAILY_MENU_FILTER_COLUMN, true)
        .order('is_sponsored', { ascending: false })
        .limit(30);

    if (error) {
        console.error("Server-side fetch error:", error);
    }

    const initialRestaurants = (data || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description || '',
        logoUrl: r.logo_url,
        coverImageUrl: r.cover_image_url,
        cuisineType: r.cuisine_type || 'Varios',
        priceLevel: Number(r.price_level) || 2,
        address: typeof r.address === 'object' && r.address !== null ? `${r.address.street || ''} ${r.address.number || ''}`.trim() : (r.address || ''),
        comuna: r.comuna || '',
        phoneNumber: r.phone,
        hasReservations: r.has_reservations ?? true,
        hasTakeaway: r.has_takeaway ?? true,
        averagePrepTimeMinutes: Number(r.average_prep_time) || 20,
        isSponsored: r.is_sponsored || false,
        isFeatured: r.is_featured || false,
        isActive: r.is_active || true,
        dailyMenus: extractDailyMenus(r)
    }));

    return (
        <>
            <HomeClient initialRestaurants={initialRestaurants} assistant={oliviaOn ? <OliviaLauncher /> : undefined} />
            <footer className="py-8 text-center border-t border-zinc-100 bg-zinc-50 space-y-3">
                <p className="text-sm font-black text-zinc-900">Almuerzo.cl</p>
                <a href="https://app2.almuerzo.cl/privacidad" className="text-xs font-bold text-zinc-500 hover:text-orange-500 transition-colors underline">
                    Politica de Privacidad
                </a>
            </footer>
        </>
    );
}
