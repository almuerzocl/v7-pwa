import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TicketDigitalView } from '@/components/TicketDigital.view';

const restaurant = { name: 'Cri-Olla', logo_url: null, address: { street: 'Av. Providencia', number: '1234', commune: 'Providencia' }, phone: '+56 2 2345 6789' };

const reservation = (over: any = {}) => ({
    id: 'abcd1234-0000', unique_code: '2A7518A4', status: 'CONFIRMADA', date_time: '2026-10-04T22:00:00Z', created_at: '2026-10-04T17:34:00Z',
    party_size: 2, payment_method: 'individual',
    guest_data: [
        { name: 'Esteban Zarate', email: 'e@saborez.cl', is_organizer: true, status: 'CONFIRMADA' },
        { name: 'Ana Pérez', email: 'a@x.cl', status: 'PENDIENTE' },
    ],
    timestamps: { SOLICITADA: { at: '2026-10-04T17:34:00Z' }, CONFIRMADA: { at: '2026-10-04T17:35:00Z' } },
    ...over,
});
const order = (over: any = {}) => ({
    id: 'ffff0000-1111', unique_code: '73425DF4', status: 'PREPARANDO', created_at: '2026-10-04T18:07:00Z', pickup_time: '15:07',
    total_amount: 11000, customer_name: 'Esteban Zarate', customer_phone: '+56912345678',
    items: [{ name: 'Pastel de Choclo', quantity: 1, price: 11000 }], ...over,
});
const html = (props: any) => renderToStaticMarkup(<TicketDigitalView {...props} />);
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('TicketDigitalView: contenido', () => {
    it('reserva: restaurante, código, estado, personas, dirección, organizador, invitados, pago y notas', () => {
        const t = text(html({ res: reservation(), restaurant, contact: { name: 'Esteban Zarate', email: 'e@saborez.cl', phone: '+56911112222' } }));
        for (const s of ['Cri-Olla', '2A7518A4', 'Confirmada', '2 Personas', 'Av. Providencia 1234, Providencia', '+56 2 2345 6789',
            'Organizador', 'e@saborez.cl', '+56911112222', 'Invitados y Asistencia', 'Ana Pérez', 'Cada uno paga lo suyo', 'Notas de llegada']) {
            expect(t).toContain(s);
        }
    });

    it('pedido: monto, datos del cliente, productos con precio y total a pagar', () => {
        const t = text(html({ res: order(), restaurant, contact: { name: 'Esteban Zarate', email: 'e@x.cl', phone: '+56912345678' } }));
        for (const s of ['Cliente', 'e@x.cl', '+56912345678', 'Monto', '$11.000', 'Pastel de Choclo', 'P. Unitario', 'Total a Pagar', 'Hora de Retiro', 'Notas de retiro']) {
            expect(t).toContain(s);
        }
    });

    it('sin contacto externo, lee el cliente del propio registro (ticket público ya enmascarado)', () => {
        const t = text(html({ res: order({ customer_phone: '+56 9 ••••• 123', customer_email: 'a•••@x.cl' }) }));
        expect(t).toContain('+56 9 ••••• 123');
        expect(t).toContain('a•••@x.cl');
    });

    it('con descuento aplicado', () => {
        const t = text(html({ res: reservation({ guest_data: [{ name: 'E Z', is_organizer: true, selected_discount: { name: 'Estudiantes', percentage: 15 } }] }) }));
        expect(t).toContain('Descuento Aplicado');
        expect(t).toContain('Estudiantes');
        expect(t).toContain('-15%');
    });

    it('con muchos ítems los lista todos y cuenta el total', () => {
        const items = Array.from({ length: 12 }, (_, i) => ({ name: `Plato ${i + 1}`, quantity: 1, price: 1000 }));
        const t = text(html({ res: order({ items, total_amount: 12000 }) }));
        expect(t).toContain('Plato 12');
        expect(t).toContain('12 TOTAL');
    });

    it('check-in: la etiqueta cruda CHECKIN_AT sale como "Check-in", incluso como texto suelto', () => {
        const res = reservation({ timestamps: { SOLICITADA: { at: '2026-10-04T17:34:00Z' }, CHECKIN_AT: '2026-10-04T21:55:00Z' } });
        const t = text(html({ res }));
        expect(t).toContain('Check-in');
        expect(t).not.toContain('CHECKIN_AT');
    });

    it('un timestamp roto no tumba el ticket', () => {
        expect(() => html({ res: reservation({ date_time: 'no-es-fecha', timestamps: { CONFIRMADA: 'basura' } }) })).not.toThrow();
    });

    it('el estado va sobre fondo blanco, también el de los invitados', () => {
        const h = html({ res: reservation() });
        expect(h).toMatch(/bg-white[^"]*"[^>]*>\s*Confirmada/);
        expect((h.match(/rounded-full border[^"]*bg-white/g) || []).length).toBeGreaterThanOrEqual(3);
    });

    it('con acciones: enlaces de calendario y acceso directo', () => {
        const t = html({ res: reservation(), showActions: true, ticketUrl: 'https://tickets2.almuerzo.cl', calendarLinks: { google: 'https://g', ics: 'data:x' } });
        expect(t).toContain('https://g');
        expect(t).toContain('/r/2A7518A4');
    });

    it('sin showActions no hay botones', () => {
        expect(html({ res: reservation(), showActions: false })).not.toContain('<button');
    });
});
