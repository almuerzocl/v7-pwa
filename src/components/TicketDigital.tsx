import React from 'react';
import { generateICSLink, sendGoogleCalendarInvitation as getGoogleCalendarLink } from '@/lib/invitations';
import { TICKET_URL } from '@/lib/config';
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

    return <TicketDigitalView res={res} showActions={showActions} calendarLinks={calendarLinks} ticketUrl={TICKET_URL} />;
}
