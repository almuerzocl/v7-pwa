import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import InvitationsPanel from '@/components/blocks/InvitationsPanel';
import ContactPickerModal from '@/components/blocks/ContactPickerModal';
import type { Contact } from '@/types';

const guests = (extra: any[] = []) => [
    { id: 'o', name: 'Esteban Zárate', is_organizer: true, status: 'CONFIRMADA', email: 'org@x.cl' },
    { id: 'g1', name: 'Camila Soto', email: 'camila.secreta@gmail.com', status: 'PENDIENTE' },
    { id: 'g2', name: 'Pedro Rojas', email: null, phone: '+56912345678', status: 'PENDIENTE' },
    ...extra,
];
const res = (status: string, g = guests()) => ({ id: 'r1', unique_code: 'K7Q2MZ', status, date_time: '2026-11-06T16:30:00Z', restaurant: { name: 'Cri-Olla' }, guest_data: g });
const html = (r: any) => renderToStaticMarkup(<InvitationsPanel res={r} />);

describe('InvitationsPanel', () => {
    it('reserva pendiente: informa que se espera al restaurante y no ofrece enviar nada', () => {
        const h = html(res('PENDIENTE'));
        expect(h).toContain('Esperando al restaurante');
        expect(h).toContain('Se enviará por correo al confirmarse');
        expect(h).toContain('Recibirá un enlace de WhatsApp');
        expect(h).not.toContain('Enviar por WhatsApp');
    });
    it('reserva confirmada: el invitado con correo solo se informa; el sin correo recibe los botones de envío', () => {
        const h = html(res('CONFIRMADA'));
        expect(h).toContain('Invitación enviada por correo');
        expect(h).toContain('Falta enviar su enlace');
        expect(h.match(/Enviar por WhatsApp/g)).toHaveLength(1); // solo Pedro
        expect(h).toContain('Copiar enlace');
        expect(h).toContain('Compartir…');
        expect(h).toContain('1 de 2 invitaciones listas'); // Camila ya recibió su correo
    });
    it('quien ya respondió no recibe botones de envío; quien confirmó sin canal queda marcado', () => {
        const h = html(res('CONFIRMADA', guests([{ id: 'g3', name: 'Marta Gil', email: null, status: 'CONFIRMADA' }, { id: 'g4', name: 'Luis Paz', email: null, status: 'RECHAZADA' }])));
        expect(h).toContain('Confirmó');
        expect(h).toContain('No irá');
        expect(h).toContain('Sin avisos de cambios'); // Marta: confirmó, sin correo y sin consentimiento
        expect(h.match(/Enviar por WhatsApp/g)).toHaveLength(1); // solo Pedro
    });
    it('quien aceptó los avisos no aparece como «sin avisos»', () => {
        const h = html(res('CONFIRMADA', guests([{ id: 'g3', name: 'Marta Gil', email: null, status: 'CONFIRMADA', notify_consent_at: '2026-10-30T10:00:00Z', notify_email: 'marta.privada@gmail.com' }])));
        expect(h).not.toContain('Sin avisos de cambios');
    });
    it('el organizador nunca ve el correo que el invitado dejó para sus avisos', () => {
        const h = html(res('CONFIRMADA', guests([{ id: 'g3', name: 'Marta Gil', email: null, status: 'CONFIRMADA', notify_consent_at: 'x', notify_email: 'marta.privada@gmail.com' }])));
        expect(h).not.toContain('marta.privada@gmail.com');
        expect(h).not.toContain('camila.secreta@gmail.com'); // ni siquiera el que él mismo escribió: la pantalla solo habla del canal
    });
    it('sin invitados no pinta nada', () => {
        expect(html(res('CONFIRMADA', [guests()[0]]))).toBe('');
    });
});

const c = (id: string, first_name: string, last_name = '', email?: string): Contact => ({ id, owner_id: 'o', first_name, last_name, email });

describe('ContactPickerModal', () => {
    const contacts = [c('1', 'Camila', 'Soto', 'camila@x.cl'), c('2', 'Ángela', 'Muñoz'), c('3', 'Carlos', 'Díaz', 'carlos@x.cl')];
    const render = (alreadyIds: string[] = [], list = contacts) =>
        renderToStaticMarkup(<ContactPickerModal contacts={list} alreadyIds={alreadyIds} onConfirm={() => {}} onClose={() => {}} />);

    it('agrupa por inicial, ordena y muestra el índice A–Z', () => {
        const h = render();
        expect(h.indexOf('Contactos con A')).toBeLessThan(h.indexOf('Contactos con C'));
        expect(h).toContain('Ángela Muñoz');
        for (const l of ['A', 'M', 'Z', '#']) expect(h).toContain(`>${l}</span>`);
    });
    it('nunca muestra correos; solo dice si recibe invitaciones', () => {
        const h = render();
        expect(h).not.toContain('camila@x.cl');
        expect(h).toContain('Recibe invitaciones por correo');
        expect(h).toContain('Sin correo: enlace de WhatsApp');
    });
    it('los ya agregados aparecen marcados y deshabilitados', () => {
        const h = render(['1']);
        expect(h).toContain('Ya agregado');
    });
    it('sin contactos explica cómo se llena la lista', () => {
        expect(render([], [])).toContain('Aún no tienes contactos guardados');
    });
    it('el botón parte deshabilitado hasta elegir a alguien', () => {
        const h = render();
        expect(h).toContain('Elige a quién invitar');
        expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Elige a quién invitar/);
    });
});
