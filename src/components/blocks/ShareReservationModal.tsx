// packages/pwa/components/ShareReservationModal.tsx
'use client';

import { format } from 'date-fns';
import { es } from 'date-fns/locale';

import { TICKET_URL } from '@/lib/config';

interface ShareReservationModalProps {
    reservation: {
        id: string;
        restaurant_name: string;
        reservation_date: string; // ISO string
        party_size: number;
        share_token: string;
        code?: string;
        durationMinutes?: number;
        address?: string;
    };
    onClose: () => void;
}

export default function ShareReservationModal({
    reservation,
    onClose,
}: ShareReservationModalProps) {
    const url = `${TICKET_URL}/r/${reservation.share_token}`;
    const title = `Reserva en ${reservation.restaurant_name}`;
    const description = `🗓️ ${format(new Date(reservation.reservation_date), 'EEEE d MMMM yyyy, HH:mm', {
        locale: es,
    })}\n👥 ${reservation.party_size} personas\n🔑 Código: ${reservation.code || ''}\n\nVer reserva: ${url}`;

    const whatsapp = `https://wa.me/?text=${encodeURIComponent(`${title}\n${description}`)}`;

    // Google Calendar Logic
    const startDate = new Date(reservation.reservation_date);
    const duration = reservation.durationMinutes || 90;
    const endDate = new Date(startDate.getTime() + duration * 60000);

    const formatGoogleDate = (date: Date) => date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    const googleCal = `https://www.google.com/calendar/render?action=TEMPLATE` +
        `&text=${encodeURIComponent(title)}` +
        `&dates=${formatGoogleDate(startDate)}/${formatGoogleDate(endDate)}` +
        `&details=${encodeURIComponent(description)}` +
        (reservation.address ? `&location=${encodeURIComponent(reservation.address)}` : '');

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl">
                <h3 className="font-bold text-lg mb-4">Compartir reserva</h3>
                <div className="flex flex-col gap-3">
                    <p className="text-sm text-gray-700"><strong>Restaurante:</strong> {reservation.restaurant_name}</p>
                    <p className="text-sm text-gray-700"><strong>Fecha:</strong> {format(new Date(reservation.reservation_date), 'EEEE d MMMM yyyy, HH:mm', { locale: es })}</p>
                    <p className="text-sm text-gray-700"><strong>Personas:</strong> {reservation.party_size}</p>
                    {reservation.code && (
                        <p className="text-sm text-gray-700"><strong>Código:</strong> {reservation.code}</p>
                    )}
                    <hr className="my-2" />
                    <a
                        href={whatsapp}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 p-3 border rounded-xl hover:bg-gray-50"
                    >
                        📱 WhatsApp
                    </a>
                    <a
                        href={googleCal}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 p-3 border rounded-xl hover:bg-gray-50"
                    >
                        📅 Google Calendar
                    </a>
                    <button
                        onClick={() => navigator.clipboard.writeText(url)}
                        className="flex items-center gap-2 p-3 border rounded-xl hover:bg-gray-50"
                    >
                        📋 Copiar enlace
                    </button>
                    <a
                        href={`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(
                            `${description}\n${url}`
                        )}`}
                        className="flex items-center gap-2 p-3 border rounded-xl hover:bg-gray-50"
                    >
                        ✉️ Email
                    </a>
                </div>
                <button
                    onClick={onClose}
                    className="mt-4 w-full py-2 bg-orange-600 text-white rounded-xl hover:bg-orange-700"
                >
                    Cerrar
                </button>
            </div>
        </div>
    );
}
