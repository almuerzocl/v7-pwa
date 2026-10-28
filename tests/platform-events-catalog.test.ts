import { describe, it, expect } from 'vitest';
import {
    PLATFORM_EVENT_TYPES, detectPlatform, errorCode, sanitizePlatformEvent, sanitizeProps, sanitizeStep, sanitizeUuid,
} from '@/lib/platform-events-catalog';

const RID = '11111111-1111-4111-8111-111111111111';
const SID = 'sess-12345678';

describe('catálogo', () => {
    it('coincide con el CHECK de platform_events (26 tipos, sin repetidos)', () => {
        expect(PLATFORM_EVENT_TYPES).toHaveLength(26);
        expect(new Set(PLATFORM_EVENT_TYPES).size).toBe(26);
        for (const t of ['session_start', 'login', 'discount_view', 'discount_apply', 'discount_remove', 'checkout_start', 'checkout_submit', 'checkout_error', 'client_error', 'offline_queue']) {
            expect(PLATFORM_EVENT_TYPES).toContain(t);
        }
    });
});

describe('sanitizeProps', () => {
    it('solo deja claves de la lista blanca, enteros acotados y textos cortos y seguros', () => {
        expect(sanitizeProps({ count: 3, step_index: 2, ms: 1500, filter: 'precio', source: 'gps', code: 'ERR_01', kind: 'order', result: 'ok' }))
            .toEqual({ count: 3, step_index: 2, ms: 1500, filter: 'precio', source: 'gps', code: 'ERR_01', kind: 'order', result: 'ok' });
    });
    it('descarta texto libre, números inválidos y claves desconocidas', () => {
        expect(sanitizeProps({ count: -1 })).toEqual({});
        expect(sanitizeProps({ count: 1.5 })).toEqual({});
        expect(sanitizeProps({ count: 1_000_000 })).toEqual({});
        expect(sanitizeProps({ count: '3' })).toEqual({});
        expect(sanitizeProps({ filter: 'texto con espacios' })).toEqual({});
        expect(sanitizeProps({ source: 'x'.repeat(41) })).toEqual({});
        expect(sanitizeProps({ query: 'pizza cerca de mi casa', email: 'a@b.cl', direccion: 'Av. Siempre Viva 742' })).toEqual({});
        expect(sanitizeProps({ code: { a: 1 } })).toEqual({});
    });
    it('tolera entradas que no son objetos', () => {
        for (const v of [null, undefined, 'x', 5, [], [1, 2]]) expect(sanitizeProps(v)).toEqual({});
    });
});

describe('sanitizeStep y sanitizeUuid', () => {
    it('el paso es corto y en minúsculas', () => {
        expect(sanitizeStep('confirmation')).toBe('confirmation');
        expect(sanitizeStep('paso:1_a-b')).toBe('paso:1_a-b');
        expect(sanitizeStep('Paso Uno')).toBeUndefined();
        expect(sanitizeStep('')).toBeUndefined();
        expect(sanitizeStep('x'.repeat(41))).toBeUndefined();
        expect(sanitizeStep(5)).toBeUndefined();
    });
    it('el id debe ser un UUID y se normaliza a minúsculas', () => {
        expect(sanitizeUuid(RID.toUpperCase())).toBe(RID);
        expect(sanitizeUuid('no-es-uuid')).toBeUndefined();
        expect(sanitizeUuid(null)).toBeUndefined();
    });
});

describe('sanitizePlatformEvent', () => {
    it('un evento válido sale en snake_case con valores por defecto seguros', () => {
        expect(sanitizePlatformEvent({ type: 'discount_view', sessionId: SID, discountId: RID.toUpperCase(), step: 'cart', platform: 'ios', standalone: true, props: { kind: 'order', junk: 'x' } }))
            .toEqual({ event_type: 'discount_view', session_id: SID, step: 'cart', restaurant_id: null, discount_id: RID, ref_id: null, platform: 'ios', standalone: true, props: { kind: 'order' } });
        expect(sanitizePlatformEvent({ type: 'login', sessionId: SID }))
            .toEqual({ event_type: 'login', session_id: SID, step: null, restaurant_id: null, discount_id: null, ref_id: null, platform: 'other', standalone: null, props: {} });
    });
    it('rechaza lo que no es del catálogo o no trae sesión válida', () => {
        expect(sanitizePlatformEvent({ type: 'hackeo', sessionId: SID })).toBeNull();
        expect(sanitizePlatformEvent({ type: 'login', sessionId: 'a' })).toBeNull();
        expect(sanitizePlatformEvent({ type: 'login' })).toBeNull();
        for (const v of [null, undefined, 'texto', 7]) expect(sanitizePlatformEvent(v)).toBeNull();
    });
    it('una plataforma desconocida pasa a "other"', () => {
        expect(sanitizePlatformEvent({ type: 'login', sessionId: SID, platform: 'windows' })?.platform).toBe('other');
    });
});

describe('errorCode', () => {
    it('usa el código o el nombre del error, nunca el mensaje', () => {
        expect(errorCode({ code: 'PGRST116', message: 'datos personales de alguien' })).toBe('PGRST116');
        expect(errorCode(new TypeError('hola juan@correo.cl'))).toBe('TypeError');
        expect(errorCode(42)).toBe('unknown');
        expect(errorCode(null)).toBe('unknown');
        expect(errorCode({ code: 'con espacios y ñ' })).toBe('con_espacios_y__');
        expect(errorCode({ code: 'x'.repeat(100) }).length).toBe(40);
    });
});

describe('detectPlatform', () => {
    it('distingue iOS, Android y escritorio', () => {
        expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5)).toBe('ios');
        expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios'); // iPad que se presenta como Mac
        expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('desktop');
        expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 5)).toBe('android');
        expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBe('desktop');
        expect(detectPlatform('', 0)).toBe('other');
    });
});
