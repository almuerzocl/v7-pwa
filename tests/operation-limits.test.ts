import { describe, expect, it } from 'vitest';
import {
    OperationLimitError,
    hasRoom,
    limitInfoFromDbError,
    limitReachedMessage,
    parseLimitInfo,
    usageLine,
} from '@/lib/operation-limits';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const detail = JSON.stringify({ limit: 'daily', limit_value: 2, used: 2, resets_at: '2026-10-25T03:00:00+00:00' });

describe('parseLimitInfo', () => {
    it('lee el DETAIL en texto y como objeto', () => {
        expect(parseLimitInfo(detail)).toMatchObject({ limit: 'daily', limit_value: 2, used: 2 });
        expect(parseLimitInfo(JSON.parse(detail))).toMatchObject({ limit: 'daily' });
    });
    it('rechaza basura sin tirar', () => {
        expect(parseLimitInfo('no es json')).toBeNull();
        expect(parseLimitInfo(null)).toBeNull();
        expect(parseLimitInfo({ limit: 'monthly', limit_value: 1, used: 1, resets_at: 'x' })).toBeNull();
        expect(parseLimitInfo({ limit: 'daily' })).toBeNull();
    });
});

describe('limitInfoFromDbError', () => {
    it('solo reconoce el HINT limit_reached', () => {
        expect(limitInfoFromDbError({ hint: 'limit_reached', details: detail })?.limit).toBe('daily');
        expect(limitInfoFromDbError({ hint: 'plan_blocked', details: detail })).toBeNull();
        expect(limitInfoFromDbError(null)).toBeNull();
    });
});

describe('limitReachedMessage', () => {
    it('diario: dice mañana y menciona Elite, sin error crudo', () => {
        const m = limitReachedMessage(parseLimitInfo(detail));
        expect(m).toBe('Llegaste a tu límite de 2 operaciones por hoy; podrás volver a pedir o reservar mañana. Con Elite no tienes límite.');
    });
    it('semanal: dice el lunes', () => {
        const m = limitReachedMessage({ limit: 'weekly', limit_value: 10, used: 10, resets_at: 'x' });
        expect(m).toContain('10 operaciones por esta semana');
        expect(m).toContain('el lunes');
    });
    it('singular y sin info', () => {
        expect(limitReachedMessage({ limit: 'daily', limit_value: 1, used: 1, resets_at: 'x' })).toContain('1 operación por hoy');
        expect(limitReachedMessage(null)).toContain('Con Elite no tienes límite');
    });
});

describe('OperationLimitError', () => {
    it('lleva el mensaje amable y la info', () => {
        const e = new OperationLimitError(parseLimitInfo(detail));
        expect(e.message).toContain('Llegaste a tu límite');
        expect(e.info?.limit).toBe('daily');
        expect(e).toBeInstanceOf(Error);
    });
});

describe('contador', () => {
    const u = { daily_used: 1, daily_limit: 2, weekly_used: 4, weekly_limit: 10 };
    it('arma "Hoy 1 de 2 · Esta semana 4 de 10"', () => expect(usageLine(u)).toBe('Hoy 1 de 2 · Esta semana 4 de 10'));
    it('hasRoom', () => {
        expect(hasRoom(u)).toBe(true);
        expect(hasRoom({ ...u, daily_used: 2 })).toBe(false);
        expect(hasRoom({ ...u, weekly_used: 10 })).toBe(false);
    });
});

describe('guardia: el límite vive en la base, no en el navegador', () => {
    it('ya no existe checkUserDailyLimit (corría en el navegador y fallaba abierto)', () => {
        const wizard = readFileSync(join(__dirname, '..', 'src/components/blocks/ReservationWizard.tsx'), 'utf8');
        expect(wizard).not.toContain('checkUserDailyLimit');
    });
    it('la acción de reserva no reenvía created_by_staff del navegador', () => {
        const action = readFileSync(join(__dirname, '..', 'src/app/actions/reservation-create-action.ts'), 'utf8');
        expect(action).not.toContain('created_by_staff');
    });
    it('el pedido no acepta created_by_staff desde la fila del navegador sin que la base lo anule (trigger)', () => {
        // La base fuerza created_by_staff=false para anon/authenticated (migración 040); aquí solo se documenta que la fila
        // del carrito no lo envía.
        const cart = readFileSync(join(__dirname, '..', 'src/app/(main)/cart/page.tsx'), 'utf8');
        expect(cart).not.toContain('created_by_staff');
    });
});
