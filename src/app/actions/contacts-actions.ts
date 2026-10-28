"use server";

import { createClient } from "@supabase/supabase-js";
import { verifyUser } from "@/utils/supabase/auth-check";

let _supabaseAdmin: ReturnType<typeof createClient> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
    }
    return _supabaseAdmin;
}

export async function fetchContactsAction(userId: string) {
    const auth = await verifyUser(userId);
    if (!auth.authorized) return { success: false, contacts: [], error: auth.error };

    try {
        const { data, error } = await supabaseAdmin()
            .from('contacts')
            .select('*')
            .eq('owner_id', userId)
            .order('first_name', { ascending: true });

        if (error) {
            console.error('[fetchContacts] Error:', error);
            return { success: false, contacts: [], error: error.message };
        }

        return { success: true, contacts: data || [] };
    } catch (err: any) {
        console.error('[fetchContacts] Exception:', err);
        return { success: false, contacts: [], error: err.message };
    }
}

export async function saveContactAction(userId: string, contact: {
    first_name: string;
    last_name?: string;
    email?: string | null;
    whatsapp_phone?: string | null;
}) {
    const auth = await verifyUser(userId);
    if (!auth.authorized) return { success: false, contact: null, error: auth.error };

    try {
        const { data, error } = await supabaseAdmin()
            .from('contacts')
            .insert({
                owner_id: userId,
                first_name: contact.first_name || 'Invitado',
                last_name: contact.last_name || '',
                email: contact.email || null,
                whatsapp_phone: contact.whatsapp_phone || null,
            })
            .select()
            .single();

        if (error) {
            console.error('[saveContact] Error:', error);
            return { success: false, contact: null, error: error.message };
        }

        return { success: true, contact: data };
    } catch (err: any) {
        console.error('[saveContact] Exception:', err);
        return { success: false, contact: null, error: err.message };
    }
}
