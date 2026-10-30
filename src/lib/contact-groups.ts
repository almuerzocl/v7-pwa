// Agrupa contactos por inicial para el selector «Mis contactos» (lista alfabética con índice A–Z). Sin dependencias de React.
import type { Contact } from '@/types';

export const RAIL = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'] as const;

/** minúsculas y sin tildes: «Ángela» y «angela» se ordenan y buscan igual. La ñ cuenta como n. */
export function normalizeKey(s: string | null | undefined): string {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function displayName(c: Pick<Contact, 'first_name' | 'last_name'>): string {
    return `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Sin nombre';
}

export function letterOf(c: Pick<Contact, 'first_name' | 'last_name'>): string {
    const first = normalizeKey(displayName(c)).charAt(0).toUpperCase();
    return first >= 'A' && first <= 'Z' ? first : '#';
}

export interface ContactGroup { letter: string; items: Contact[] }

/** Contactos filtrados por `query` (nombre o apellido, sin tildes), ordenados y agrupados; «#» siempre al final. */
export function groupContacts(contacts: Contact[], query = ''): ContactGroup[] {
    const q = normalizeKey(query);
    const filtered = q ? contacts.filter((c) => normalizeKey(displayName(c)).includes(q)) : contacts;
    const sorted = [...filtered].sort((a, b) => normalizeKey(displayName(a)).localeCompare(normalizeKey(displayName(b)), 'es'));
    const map = new Map<string, Contact[]>();
    for (const c of sorted) {
        const l = letterOf(c);
        map.set(l, [...(map.get(l) ?? []), c]);
    }
    return [...map.entries()]
        .sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
        .map(([letter, items]) => ({ letter, items }));
}

/** Letra del índice que corresponde a la posición `idx` del índice: la presente más cercana hacia abajo y, si no hay, hacia arriba. */
export function nearestPresentLetter(idx: number, present: ReadonlySet<string>): string | null {
    for (let i = Math.max(0, idx); i < RAIL.length; i++) if (present.has(RAIL[i])) return RAIL[i];
    for (let i = Math.min(idx, RAIL.length - 1); i >= 0; i--) if (present.has(RAIL[i])) return RAIL[i];
    return null;
}
