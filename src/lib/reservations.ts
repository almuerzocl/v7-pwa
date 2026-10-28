// lib/reservations.ts
import { supabase } from './supabase';
import { v4 as uuidv4 } from 'uuid';
import type { Contact } from '@/types';

/** Generate a short share token (8 chars) */
export const generateShareToken = (): string =>
    uuidv4().replace(/-/g, '').slice(0, 8);

/** Log an event for a reservation (e.g., created, approved, arrived) */
export async function logReservationEvent(
    reservationId: string,
    event: string
) {
    const { error } = await supabase
        .from('reservation_logs')
        .insert({ reservation_id: reservationId, event });
    if (error) console.error('Reservation log error', error);
}

/** Add an invitee to a reservation */
export async function addInvitee(
    reservationId: string,
    contactId: string
) {
    const { error } = await supabase
        .from('reservation_invitees')
        .insert({ reservation_id: reservationId, contact_id: contactId });
    if (error) throw error;
}

/** Fetch contacts for the current user (used in the wizard) */
export async function fetchUserContacts(userId: string): Promise<Contact[]> {
    const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('owner_id', userId)
        .order('first_name', { ascending: true });
    if (error) throw error;
    return data as any;
}
