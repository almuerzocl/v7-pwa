import { describe, it, expect } from 'vitest';
import { parseVCards, normalizePhone } from '@/lib/vcard';

const v3 = `BEGIN:VCARD
VERSION:3.0
N:Pérez;Ana María;;;
FN:Ana María Pérez
TEL;type=CELL;type=VOICE;type=pref:+56 9 1234 5678
EMAIL;type=INTERNET;type=HOME:ana@example.cl
END:VCARD
`;

describe('parseVCards', () => {
    it('lee una tarjeta 3.0 de iPhone', () => {
        expect(parseVCards(v3)).toEqual([{ first_name: 'Ana María', last_name: 'Pérez', email: 'ana@example.cl', phone: '+56912345678' }]);
    });
    it('lee varias tarjetas y CRLF', () => {
        const two = (v3 + v3.replace('Ana María', 'Luis').replace('Pérez', 'Soto')).replace(/\n/g, '\r\n');
        const r = parseVCards(two);
        expect(r).toHaveLength(2);
        expect(r[1].last_name).toBe('Soto');
    });
    it('sin N usa FN', () => {
        const r = parseVCards('BEGIN:VCARD\nVERSION:4.0\nFN:Carlos Díaz Rojas\nTEL:tel:+56 2 2345 6789\nEND:VCARD');
        expect(r[0]).toMatchObject({ first_name: 'Carlos', last_name: 'Díaz Rojas', phone: '+56223456789' });
    });
    it('une líneas plegadas y quita el grupo itemN.', () => {
        const r = parseVCards('BEGIN:VCARD\nFN:Ana\nitem1.EMAIL:ana@exam\n ple.cl\nEND:VCARD');
        expect(r[0].email).toBe('ana@example.cl');
    });
    it('decodifica quoted-printable (vCard 2.1)', () => {
        const r = parseVCards('BEGIN:VCARD\nVERSION:2.1\nN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:P=C3=A9rez;Jos=C3=A9\nTEL:912345678\nEND:VCARD');
        expect(r[0]).toMatchObject({ first_name: 'José', last_name: 'Pérez' });
    });
    it('descarta tarjetas sin nombre o sin teléfono/correo, y teléfonos inválidos', () => {
        expect(parseVCards('BEGIN:VCARD\nFN:Solo Nombre\nEND:VCARD')).toEqual([]);
        expect(parseVCards('BEGIN:VCARD\nTEL:912345678\nEND:VCARD')).toEqual([]);
        expect(parseVCards('BEGIN:VCARD\nFN:X\nTEL:123\nEMAIL:no-es-correo\nEND:VCARD')).toEqual([]);
    });
    it('ignora texto que no es vCard', () => {
        expect(parseVCards('hola mundo')).toEqual([]);
    });
});

describe('normalizePhone', () => {
    it('deja dígitos y +', () => {
        expect(normalizePhone('(+56) 9-1234 5678')).toBe('+56912345678');
        expect(normalizePhone('9 1234 5678')).toBe('912345678');
        expect(normalizePhone('12')).toBeNull();
    });
});
