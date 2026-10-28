// packages/pwa/lib/invitations.ts
import { TIMEZONE } from '@/lib/config';

/**
 * Placeholder service for sending reservation invitations.
 * In a real production app you would integrate with SendGrid (email), Twilio/WhatsApp API, and Google Calendar API.
 * For now we simply log the actions and return a resolved promise so the UI flow works.
 */

export async function sendGoogleCalendarInvitation({
    title,
    startISO,
    endISO,
    description,
    location,
    cardLink,
}: {
    title: string;
    startISO: string;
    endISO: string;
    description: string;
    location?: string;
    cardLink?: string;
}) {
    const finalDescription = cardLink
        ? `${description}\n\nVer ticket de reserva: ${cardLink}`
        : description;

    console.log('📅 Creating Google Calendar link', {
        title,
        startISO,
        endISO,
        description: finalDescription,
        location,
    });

    // Format date specifically for Chile (America/Santiago)
    // This ensures we extract the correct YYYYMMDDTHHMMSS that represents the local time in Chile
    // regardless of the server (or browser) timezone.
    const formatToChileTime = (iso: string) => {
        const d = new Date(iso);
        const formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        const parts = formatter.formatToParts(d);
        const getPart = (type: string) => parts.find(p => p.type === type)?.value;
        return `${getPart('year')}${getPart('month')}${getPart('day')}T${getPart('hour')}${getPart('minute')}${getPart('second')}`;
    };

    const startDate = formatToChileTime(startISO);
    const endDate = formatToChileTime(endISO);
    const dates = `${startDate}/${endDate}`;

    const link = `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
        title
    )}&dates=${dates}&details=${encodeURIComponent(finalDescription)}&location=${encodeURIComponent(
        location || ''
    )}&ctz=${TIMEZONE}`;
    return Promise.resolve(link);
}

export function generateICSLink({
    title,
    startISO,
    endISO,
    description,
    location,
}: {
    title: string;
    startISO: string;
    endISO: string;
    description: string;
    location?: string;
}) {
    const formatToICSDate = (iso: string) => {
        return iso.replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    const start = formatToICSDate(startISO);
    const end = formatToICSDate(endISO);

    const icsContent = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Almuerzo//NONSGML v1.0//EN',
        'BEGIN:VEVENT',
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${title}`,
        `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
        `LOCATION:${location || ''}`,
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\n');

    return `data:text/calendar;charset=utf8,${encodeURIComponent(icsContent)}`;
}
