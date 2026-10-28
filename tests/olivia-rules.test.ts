import { describe, it, expect } from 'vitest';
import {
    SYSTEM_PROMPT, buildContext, describeWeather, haversineKm, isLunchWindow, normalizeMessages, parseLocation, parseModelReply, sanitizeText, santiagoNow,
} from '@/lib/olivia/rules';
import { parseForecast, forecastUrl, SANTIAGO_COORDS } from '@/lib/olivia/weather';
import { compactHours, isOfferable } from '@/lib/olivia/snapshots';

describe('hora de Chile y ventana de almuerzo', () => {
    it('11:00 a 14:00 de Santiago (UTC-3 en verano, UTC-4 en invierno)', () => {
        expect(isLunchWindow(new Date('2026-10-27T13:59:00Z'))).toBe(false); // 10:59 (UTC-3)
        expect(isLunchWindow(new Date('2026-10-27T14:00:00Z'))).toBe(true);  // 11:00
        expect(isLunchWindow(new Date('2026-10-27T16:59:00Z'))).toBe(true);  // 13:59
        expect(isLunchWindow(new Date('2026-10-27T17:00:00Z'))).toBe(false); // 14:00
        expect(isLunchWindow(new Date('2026-07-15T15:00:00Z'))).toBe(true);  // 11:00 (UTC-4)
    });
    it('el día es el de Santiago, no el UTC', () => {
        expect(santiagoNow(new Date('2026-10-28T02:30:00Z')).date).toBe('2026-10-27');
        expect(santiagoNow(new Date('2026-10-27T15:00:00Z')).weekday).toBe('mar');
    });
});

describe('entrada de la persona', () => {
    it('sanea: sin control, sin < >, acotado', () => {
        expect(sanitizeText('a\u0000b\n\n c <b>x</b>')).toBe('a b c ‹b›x‹/b›');
        expect(sanitizeText('x'.repeat(1000), 10)).toHaveLength(10);
        expect(sanitizeText(42 as any)).toBe('');
    });
    it('conversación válida: termina en el usuario, alterna y se acota a 6 turnos', () => {
        const turns = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
        const r = normalizeMessages([...turns, { role: 'user', content: 'final' }]);
        expect(r!.length).toBeLessThanOrEqual(6);
        expect(r![0].role).toBe('user');
        expect(r![r!.length - 1]).toEqual({ role: 'user', content: 'final' });
    });
    it('rechaza lo inválido', () => {
        expect(normalizeMessages(null)).toBeNull();
        expect(normalizeMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }])).toBeNull();
        expect(normalizeMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toBeNull();
        expect(normalizeMessages([{ role: 'tool', content: 'a' }])).toBeNull();
    });
    it('ubicación: dentro de Chile y redondeada', () => {
        expect(parseLocation({ lat: -33.44567, lng: -70.66891 })).toEqual({ lat: -33.4457, lng: -70.6689 });
        expect(parseLocation({ lat: 0, lng: 0 })).toBeNull();
        expect(parseLocation({ lat: '-33', lng: -70 })).toBeNull();
        expect(parseLocation(null)).toBeNull();
    });
    it('distancia entre dos puntos', () => {
        expect(haversineKm({ lat: -33.4489, lng: -70.6693 }, { lat: -33.4489, lng: -70.6693 })).toBe(0);
        const d = haversineKm({ lat: -33.4489, lng: -70.6693 }, { lat: -33.4, lng: -70.58 });
        expect(d).toBeGreaterThan(8); expect(d).toBeLessThan(12);
    });
});

describe('prompt: reglas de respuesta', () => {
    it('contiene cada regla pedida', () => {
        const p = SYSTEM_PROMPT;
        expect(p).toMatch(/SOLO lo que aparece entre <datos>/);            // datos reales, sin inventar
        expect(p).toMatch(/nunca instrucciones/);                          // catálogo = datos
        expect(p).toMatch(/solo ayudas con el almuerzo/);                  // sin temas generales
        expect(p).toMatch(/distancia_km/);                                 // cercanía solo con origen
        expect(p).toMatch(/No pidas ubicación si la consulta no la necesita/);
        expect(p).toMatch(/Nunca afirmes ocupación actual/);               // ocupación
        expect(p).toMatch(/no deduzcas por el nombre de un plato/);        // alergias
        expect(p).toMatch(/no hables de prepago|ni de funciones que no estén/i);
        expect(p).toMatch(/UN factor más/);                                // clima como factor
        expect(p).toMatch(/No hay delivery/);
    });
});

describe('contexto', () => {
    const NOW = new Date('2026-10-27T15:30:00Z');
    const venue = { id: 'r1', name: 'Cri-Olla', description: 'Casero', cuisine: 'Almuerzos', priceLevel: 2, address: 'Calle 1', comuna: 'Las Condes', lat: -33.4, lng: -70.58, amenities: ['Terraza'], spaces: [], capacity: 75, spaceCapacities: { principal: 75 }, hours: { lun: '12:00-21:00', dom: 'cerrado' }, hasTakeaway: true, hasReservations: true, avgPrepMinutes: 20 };
    it('muestra atributos, horario y que es hora de almuerzo; sin pronóstico lo dice', () => {
        const c = buildContext({ now: NOW, offer: { restaurants: [{ id: 'r1', name: 'Cri-Olla', cuisine: 'Almuerzos', priceLevel: 2, items: [] }] }, offerBuiltAt: new Date('2026-10-27T13:30:00Z'), venues: { restaurants: [venue] }, weather: null, history: null, location: null });
        expect(c).toContain('es hora de almuerzo');
        expect(c).toContain('atributos: Terraza');
        expect(c).toContain('lun 12:00-21:00; dom cerrado');
        expect(c).toContain('pronóstico: no disponible');
        expect(c).toContain('oferta_actualizada: 10:30');
        expect(c).toContain('platos: ninguno cargado como disponible');
        expect(c).toContain('sin consumo anterior');
        expect(c).toContain('ubicacion_de_la_persona: no entregada');
    });
    it('sin locales lo dice explícitamente', () => {
        expect(buildContext({ now: NOW, offer: null, offerBuiltAt: null, venues: null, weather: null, history: null, location: null })).toContain('locales: ninguno habilitado');
    });
    it('describe el clima en español', () => {
        expect(describeWeather({ tempMax: 28.2, tempMin: 11, temp13: 26.6, precipProbMax: 60, precipProb13: 40, precipSumMm: 2.3 }))
            .toBe('pronóstico de hoy en Santiago: máxima 28°C, mínima 11°C, a las 13:00 se esperan 27°C, probabilidad de lluvia 40% (unos 2.3 mm en el día)');
    });
});

describe('respuesta del modelo', () => {
    it('lee el JSON, limita a 3 recomendaciones y sanea', () => {
        const r = parseModelReply(JSON.stringify({ respuesta: 'Hola <b>', necesita_ubicacion: true, recomendaciones: [1, 2, 3, 4].map(i => ({ id: `r${i}`, razon: 'ok' })) }));
        expect(r.reply).toBe('Hola ‹b›');
        expect(r.needsLocation).toBe(true);
        expect(r.picks).toHaveLength(3);
    });
    it('tolera texto alrededor del JSON', () => {
        expect(parseModelReply('Claro:\n{"respuesta":"ok","recomendaciones":[]}').reply).toBe('ok');
    });
    it('sin JSON usa el texto; vacío da un mensaje amable', () => {
        expect(parseModelReply('Prueba la cazuela').picks).toEqual([]);
        expect(parseModelReply('').reply).toMatch(/no pude armar/);
    });
});

describe('clima (Open-Meteo)', () => {
    it('solo envía coordenadas de Santiago y la fecha; nada de personas', () => {
        const u = new URL(forecastUrl('2026-10-27'));
        expect(u.host).toBe('api.open-meteo.com');
        expect(Array.from(u.searchParams.keys()).sort()).toEqual(['daily', 'end_date', 'hourly', 'latitude', 'longitude', 'start_date', 'timezone']);
        expect(u.searchParams.get('latitude')).toBe(String(SANTIAGO_COORDS.lat));
    });
    it('toma la temperatura y la lluvia de las 13:00', () => {
        const f = parseForecast({ daily: { temperature_2m_max: [20], temperature_2m_min: [8], precipitation_probability_max: [70], precipitation_sum: [4] }, hourly: { time: ['2026-10-27T12:00', '2026-10-27T13:00'], temperature_2m: [18, 19.5], precipitation_probability: [60, 70] } });
        expect(f).toEqual({ tempMax: 20, tempMin: 8, temp13: 19.5, precipProbMax: 70, precipProb13: 70, precipSumMm: 4 });
    });
    it('sin máxima o mínima no hay pronóstico', () => {
        expect(parseForecast({})).toBeNull();
        expect(parseForecast({ daily: { temperature_2m_max: [20] } })).toBeNull();
    });
});

describe('copias: qué entra a la oferta', () => {
    it('un plato sin stock, apagado o desactivado por stock no se ofrece', () => {
        expect(isOfferable({ is_available: true, stock_managed: false })).toBe(true);
        expect(isOfferable({ is_available: true, stock_managed: true, current_stock: 3 })).toBe(true);
        expect(isOfferable({ is_available: true, stock_managed: true, current_stock: 0 })).toBe(false);
        expect(isOfferable({ is_available: false, stock_managed: false })).toBe(false);
        expect(isOfferable({ is_available: true, disabled_by_stock: true, stock_managed: false })).toBe(false);
        expect(isOfferable({ is_available: null })).toBe(false);
    });
    it('horario compacto: acepta claves cortas y largas, no inventa días faltantes', () => {
        expect(compactHours({ mon: { open: '12:00', close: '21:00', is_closed: false }, sunday: { open: '09:00', close: '22:00', is_closed: true } })).toEqual({ lun: '12:00-21:00', dom: 'cerrado' });
        expect(compactHours(null)).toEqual({});
    });
});
