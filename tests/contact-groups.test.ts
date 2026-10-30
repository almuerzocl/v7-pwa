import { describe, it, expect } from 'vitest';
import { groupContacts, letterOf, nearestPresentLetter, normalizeKey, RAIL } from '@/lib/contact-groups';
import type { Contact } from '@/types';

const c = (id: string, first_name: string, last_name = ''): Contact => ({ id, owner_id: 'o', first_name, last_name });

describe('contact-groups', () => {
    it('normaliza tildes y mayúsculas', () => {
        expect(normalizeKey('  ÁNGELA Muñoz ')).toBe('angela munoz');
    });
    it('la inicial ignora tildes; la ñ cuenta como N; lo que no es letra va a #', () => {
        expect(letterOf(c('1', 'Ángela'))).toBe('A');
        expect(letterOf(c('2', 'Ñandú'))).toBe('N');
        expect(letterOf(c('3', '8ball'))).toBe('#');
        expect(letterOf(c('4', '', ''))).toBe('S'); // «Sin nombre»
    });
    it('agrupa y ordena alfabéticamente; # al final', () => {
        const g = groupContacts([c('1', 'Carlos'), c('2', 'ana'), c('3', 'Álvaro'), c('4', '2Pac'), c('5', 'Beatriz')]);
        expect(g.map((x) => x.letter)).toEqual(['A', 'B', 'C', '#']);
        expect(g[0].items.map((x) => x.first_name)).toEqual(['Álvaro', 'ana']);
    });
    it('busca por nombre o apellido sin tildes', () => {
        const all = [c('1', 'Camila', 'Soto'), c('2', 'Pedro', 'Rojas'), c('3', 'Ángela', 'Muñoz')];
        expect(groupContacts(all, 'munoz').flatMap((g) => g.items.map((x) => x.id))).toEqual(['3']);
        expect(groupContacts(all, 'ROJ').flatMap((g) => g.items.map((x) => x.id))).toEqual(['2']);
        expect(groupContacts(all, 'zzz')).toEqual([]);
    });
    it('el índice cae en la letra presente más cercana (abajo primero, luego arriba)', () => {
        const present = new Set(['B', 'M']);
        expect(nearestPresentLetter(RAIL.indexOf('A'), present)).toBe('B');
        expect(nearestPresentLetter(RAIL.indexOf('C'), present)).toBe('M');
        expect(nearestPresentLetter(RAIL.indexOf('Z'), present)).toBe('M'); // no hay nada abajo
        expect(nearestPresentLetter(5, new Set())).toBeNull();
    });
});
