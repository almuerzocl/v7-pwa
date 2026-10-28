import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ELITE_PRODUCT_URL, displayReputation, eliteStatusFrom } from '@/lib/elite';

const NOW = new Date('2026-11-10T12:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 24 * 3600 * 1000).toISOString();

describe('displayReputation', () => {
    it('ELITE ve 100 aunque su reputación real sea menor', () => {
        const p = { account_type: 'elite', reservation_reputation: 40, takeaway_reputation: 55 };
        expect(displayReputation(p, 'reservation')).toBe(100);
        expect(displayReputation(p, 'takeaway')).toBe(100);
    });
    it('FREE ve su reputación real por ámbito', () => {
        const p = { account_type: 'free', reservation_reputation: 40, takeaway_reputation: 55 };
        expect(displayReputation(p, 'reservation')).toBe(40);
        expect(displayReputation(p, 'takeaway')).toBe(55);
    });
    it('sin perfil o sin dato: null (no inventa un número)', () => {
        expect(displayReputation(null, 'reservation')).toBeNull();
        expect(displayReputation({ account_type: 'free' }, 'takeaway')).toBeNull();
    });
});

describe('eliteStatusFrom (misma regla que is_elite en la base)', () => {
    const vigente = { starts_at: day(-5), ends_at: day(25), status: 'vigente' };
    it('período corriendo: activo y con fecha de fin', () => {
        const s = eliteStatusFrom([vigente], 0, NOW);
        expect(s.active).toBe(true);
        expect(s.endsAt).toBe(day(25));
    });
    it('el «hasta cuándo» incluye lo pagado por adelantado (período en cola)', () => {
        const s = eliteStatusFrom([vigente, { starts_at: day(25), ends_at: day(55), status: 'en_cola' }], 0, NOW);
        expect(s.endsAt).toBe(day(55));
    });
    it('3 días de gracia tras el fin, y no más', () => {
        const ended = { starts_at: day(-33), ends_at: day(-1), status: 'vencido' };
        expect(eliteStatusFrom([ended], 0, NOW).active).toBe(true);
        expect(eliteStatusFrom([{ ...ended, ends_at: day(-3) }], 0, NOW).active).toBe(false);
    });
    it('período anulado o aún no iniciado: no activo', () => {
        expect(eliteStatusFrom([{ ...vigente, status: 'anulado' }], 0, NOW).active).toBe(false);
        expect(eliteStatusFrom([{ starts_at: day(2), ends_at: day(32), status: 'en_cola' }], 0, NOW).active).toBe(false);
    });
    it('sin períodos: no activo y sin fecha; la compra pendiente se informa aparte', () => {
        expect(eliteStatusFrom([], 0, NOW)).toEqual({ active: false, endsAt: null, pending: false });
        expect(eliteStatusFrom([], 2, NOW).pending).toBe(true);
    });
});

describe('cableado (guardias de texto)', () => {
    const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
    it('«Subir a Elite» ya no es un mailto: lleva a la página del producto en la tienda', () => {
        const page = read('src/app/(main)/subscriptions/page.tsx');
        expect(page).not.toMatch(/mailto:soporte@almuerzo\.cl\?subject=Quiero/);
        expect(page).toContain('ELITE_PRODUCT_URL');
        expect(ELITE_PRODUCT_URL).toBe('https://almuerzo.cl/products/suscripcion-elite-comensales');
    });
    it('la reserva toma la reputación del servidor con effective_reputation (100 para ELITE)', () => {
        const action = read('src/app/actions/reservation-create-action.ts');
        expect(action).toContain("rpc('effective_reputation'");
        expect(action).not.toMatch(/\.select\('reservation_reputation'\)/);
    });
    it('la acción de estado no es invocable con parámetros del navegador (usa solo la sesión)', () => {
        const action = read('src/app/actions/elite-status-action.ts');
        expect(action).toMatch(/export async function getEliteStatusAction\(\)/);
        expect(action).toContain('auth.getUser()');
    });
});
