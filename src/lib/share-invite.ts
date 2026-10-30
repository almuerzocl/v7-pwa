/**
 * Invitación por enlace: el organizador envía a cada invitado su enlace personal
 * (`/v/<código>?g=<id del invitado>` en public-tickets, donde responde asistencia).
 * En el teléfono usa la hoja de compartir del sistema (WhatsApp, Mensajes, etc.); sin ella,
 * abre WhatsApp con el texto y, si tampoco es posible, copia el mensaje.
 */
export interface InviteInput {
    ticketBaseUrl: string;
    uniqueCode: string;
    guestId: string;
    guestName?: string | null;
    organizerName?: string | null;
    restaurantName?: string | null;
    dateTime?: string | null;
}

export type ShareResult = 'shared' | 'whatsapp' | 'copied' | 'cancelled' | 'failed';

export function buildInviteUrl(i: Pick<InviteInput, 'ticketBaseUrl' | 'uniqueCode' | 'guestId'>): string {
    const base = i.ticketBaseUrl.replace(/\/+$/, '');
    return `${base}/v/${encodeURIComponent(i.uniqueCode)}?g=${encodeURIComponent(i.guestId)}`;
}

function formatWhen(dateTime?: string | null): string | null {
    if (!dateTime) return null;
    const d = new Date(dateTime);
    if (isNaN(d.getTime())) return null;
    const s = new Intl.DateTimeFormat('es-CL', {
        timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
    return s;
}

export function buildInviteMessage(i: InviteInput): { text: string; url: string } {
    const url = buildInviteUrl(i);
    const first = (i.guestName || '').trim().split(/\s+/)[0];
    const who = i.organizerName ? `${i.organizerName} te invita` : 'Te invitan';
    const where = i.restaurantName ? ` a ${i.restaurantName}` : '';
    const when = formatWhen(i.dateTime);
    const text = `${first ? `Hola ${first}! ` : ''}${who}${where}${when ? ` el ${when}` : ''}. Confirma tu asistencia aquí:`;
    return { text, url };
}

export async function shareInvite(i: InviteInput): Promise<ShareResult> {
    const { text, url } = buildInviteMessage(i);
    try {
        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
            await navigator.share({ title: 'Invitación', text, url });
            return 'shared';
        }
    } catch (e: any) {
        if (e?.name === 'AbortError') return 'cancelled';
        // otro error del sistema: seguimos con el respaldo
    }
    try {
        const wa = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
        const w = typeof window !== 'undefined' ? window.open(wa, '_blank', 'noopener') : null;
        if (w) return 'whatsapp';
    } catch { /* sigue al portapapeles */ }
    try {
        await navigator.clipboard.writeText(`${text} ${url}`);
        return 'copied';
    } catch {
        return 'failed';
    }
}
