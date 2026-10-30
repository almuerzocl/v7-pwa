import React from 'react';
import { generateICSLink, sendGoogleCalendarInvitation as getGoogleCalendarLink } from '@/lib/invitations';
import { TICKET_URL } from '@/lib/config';
import { shareInvite } from '@/lib/share-invite';
import toast from 'react-hot-toast';
import { useAuth } from '@/context/AuthContext';
import { TicketDigitalView } from './TicketDigital.view';

interface TicketDigitalProps {
    res: any;
    showActions?: boolean;
}

/**
 * Ticket digital de PWA. La presentación vive en `TicketDigital.view.tsx` (archivo
 * compartido e idéntico en los tres repos); aquí solo va lo propio de este repo: los enlaces de
 * calendario y la URL pública. No recibe parámetros del restaurante ni reputación del cliente:
 * el ticket usa únicamente los datos que ya entrega el registro (en public-tickets, ya proyectados
 * y enmascarados por el servidor).
 */
export function TicketDigital({ res, showActions = true }: TicketDigitalProps) {
    const { user } = useAuth();
    const isOrder = !!res?.items && Array.isArray(res.items) && res.items.length > 0 && !res.party_size && !res.guest_data;
    const [calendarLinks, setCalendarLinks] = React.useState<{ google: string; ics: string } | null>(null);

    React.useEffect(() => {
        if (!res || isOrder || !showActions) return;
        const d = new Date(res.date_time || res.created_at);
        if (isNaN(d.getTime())) return;
        const name = res.restaurant?.name || 'Restaurante';
        const ticketUrl = typeof window !== 'undefined' ? `${window.location.origin}/r/${res.unique_code}` : '';
        const startISO = d.toISOString();
        const endISO = new Date(d.getTime() + 2 * 60 * 60 * 1000).toISOString();
        let cancelled = false;
        (async () => {
            const google = await getGoogleCalendarLink({
                title: `Reserva en ${name}`, startISO, endISO,
                description: `Reserva en ${name}. Ticket digital: ${ticketUrl}`, location: name, cardLink: ticketUrl,
            });
            const ics = generateICSLink({
                title: `Reserva en ${name}`, startISO, endISO,
                description: `Reserva en ${name}. Ticket: ${ticketUrl}`, location: name,
            });
            if (!cancelled) setCalendarLinks({ google, ics });
        })();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [res?.id, res?.status, isOrder, showActions]);

    const onInviteGuest = React.useCallback(async (guest: any) => {
        const list: any[] = Array.isArray(res?.guest_data) ? res.guest_data : [];
        const organizer = list.find(g => g.is_organizer);
        const result = await shareInvite({
            ticketBaseUrl: TICKET_URL,
            uniqueCode: res.unique_code,
            guestId: guest.id,
            guestName: guest.name || guest.firstName,
            organizerName: organizer?.name || organizer?.firstName,
            restaurantName: res.restaurant?.name,
            dateTime: res.date_time,
        });
        if (result === 'copied') toast.success('Invitación copiada. Pégala en WhatsApp o donde prefieras.');
        else if (result === 'failed') toast.error('No se pudo compartir la invitación');
    }, [res]);

    // Solo el organizador envía invitaciones (un invitado que ve la reserva en "Mis reservas" no).
    const isOrganizer = !!user?.id && !!res?.organizer_id && res.organizer_id === user.id;
    const canInvite = showActions && !isOrder && !!res?.unique_code && isOrganizer;
    return <TicketDigitalView res={res} showActions={showActions} calendarLinks={calendarLinks} ticketUrl={TICKET_URL}
        onInviteGuest={canInvite ? onInviteGuest : undefined} />;
}
