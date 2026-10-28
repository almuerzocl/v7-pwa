import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { noStoreFetch } from "@/lib/supabase/no-store-fetch";
import { notFound } from "next/navigation";
import RestaurantDetailClient from "./RestaurantDetailClient";

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

export default async function RestaurantPage({ params }: Props) {
    const { data } = await supabaseAdmin()
        .from('restaurants')
        .select('id, name, description, logo_url, cover_image_url, cuisine_type, comuna, address, phone, rating_google, has_reservations, has_takeaway, opening_hours, space_capacities, amenities, plan_hidden')
        .eq('id', params.id)
        .single();

    if (!data) notFound();

    return <RestaurantDetailClient restaurant={data} id={params.id} />;
}
