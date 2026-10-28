import { describe, expect, it } from 'vitest';
import {
    computeDailySlots,
    evaluateReservationSlot,
    loadDayInputs,
    reservationOccupiedUntil,
    type DayInputs,
    type SlotRestaurant,
} from '../src/lib/core-business/reservation-slots';

// Santiago está en UTC-3 en octubre. 2026-10-05 es lunes. Hora local 08:00 = 11:00Z.
const NOW = new Date('2026-10-05T11:00:00Z');
const local = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-03:00`);

const HOURS = {
    mon: { open: '12:00', close: '16:00', is_closed: false },
    tue: { open: '12:00', close: '16:00', is_closed: false },
    wed: { open: '12:00', close: '23:00', is_closed: false },
    thu: { open: '10:00', close: '16:00', is_closed: false },
    fri: { open: '12:00', close: '16:00', is_closed: false },
    // sábado y domingo sin configuración = cerrado (así está Cri-Olla en producción)
};

function inputs(over: Partial<SlotRestaurant> = {}, extra: Partial<DayInputs> = {}): DayInputs {
    return {
        restaurant: {
            slot_duration: 90, space_capacities: null, opening_hours: HOURS, capacity: 75, is_active: true, ...over,
        },
        reservations: [],
        blocks: [],
        ...extra,
    };
}
const check = (i: DayInputs, dt: Date, party = 2, now = NOW) => {
    const r = evaluateReservationSlot(i, dt, party, now);
    return r.ok ? 'OK' : r.code;
};

describe('día y horario', () => {
    it.each([
        ['lunes dentro de horario', local('2026-10-05', '12:30'), 'OK'],
        ['lunes justo a la apertura', local('2026-10-05', '12:00'), 'OK'],
        ['lunes último horario antes del cierre', local('2026-10-05', '15:30'), 'OK'],
        ['sábado (sin configuración) = cerrado', local('2026-10-10', '13:00'), 'CLOSED'],
        ['domingo = cerrado', local('2026-10-11', '13:00'), 'CLOSED'],
        ['lunes antes de abrir', local('2026-10-05', '11:30'), 'OUTSIDE_HOURS'],
        ['lunes justo al cierre (ya no se ofrece)', local('2026-10-05', '16:00'), 'OUTSIDE_HOURS'],
        ['lunes de noche', local('2026-10-05', '21:00'), 'OUTSIDE_HOURS'],
        ['hora fuera de la grilla de 30 min', local('2026-10-05', '12:10'), 'OUTSIDE_HOURS'],
        ['jueves abre 10:00', local('2026-10-08', '10:30'), 'OK'],
        ['miércoles hasta las 23:00', local('2026-10-07', '22:30'), 'OK'],
    ])('%s', (_n, dt, expected) => {
        expect(check(inputs(), dt)).toBe(expected);
    });

    it('día marcado is_closed = cerrado', () => {
        const i = inputs({ opening_hours: { ...HOURS, mon: { open: '12:00', close: '16:00', is_closed: true } } });
        expect(check(i, local('2026-10-05', '12:30'))).toBe('CLOSED');
    });

    it('is_closed como texto "true" también cierra', () => {
        const i = inputs({ opening_hours: { ...HOURS, mon: { open: '12:00', close: '16:00', is_closed: 'true' } } });
        expect(check(i, local('2026-10-05', '12:30'))).toBe('CLOSED');
    });

    it('opening_hours vacío o nulo = siempre cerrado', () => {
        expect(check(inputs({ opening_hours: {} }), local('2026-10-05', '12:30'))).toBe('CLOSED');
        expect(check(inputs({ opening_hours: null }), local('2026-10-05', '12:30'))).toBe('CLOSED');
    });

    it.each([
        ['claves largas en inglés', { monday: { open: '12:00', close: '16:00' } }],
        ['claves en español', { lunes: { open: '12:00', close: '16:00' } }],
        ['arreglo con day', [{ day: 'mon', open: '12:00', close: '16:00' }]],
        ['formato hours "12:00-16:00"', { mon: { hours: '12:00-16:00' } }],
    ])('formatos de horario: %s', (_n, hours) => {
        expect(check(inputs({ opening_hours: hours }), local('2026-10-05', '12:30'))).toBe('OK');
        expect(check(inputs({ opening_hours: hours }), local('2026-10-05', '17:00'))).toBe('OUTSIDE_HOURS');
    });

    it('varios turnos: almuerzo y cena, nada entre medio', () => {
        const i = inputs({ opening_hours: { mon: [{ open: '12:00', close: '15:00' }, { open: '20:00', close: '23:00' }] } });
        expect(check(i, local('2026-10-05', '13:00'))).toBe('OK');
        expect(check(i, local('2026-10-05', '21:00'))).toBe('OK');
        expect(check(i, local('2026-10-05', '17:00'))).toBe('OUTSIDE_HOURS');
    });

    it('turno que cruza la medianoche: horarios de la noche del mismo día', () => {
        const i = inputs({ opening_hours: { mon: { open: '20:00', close: '02:00' } } });
        expect(check(i, local('2026-10-05', '23:30'))).toBe('OK');
    });

    // La pantalla ofrece 00:00-01:30 del martes dentro del turno del lunes (start = martes). El servidor debe
    // aceptarlo aunque la fecha local de la hora pedida sea martes.
    it.each([
        ['madrugada del día siguiente, dentro del turno del lunes', local('2026-10-06', '01:00'), 'OK'],
        ['último horario antes del cierre de las 02:00', local('2026-10-06', '01:30'), 'OK'],
        ['justo al cierre de las 02:00 (ya no se ofrece)', local('2026-10-06', '02:00'), 'OUTSIDE_HOURS'],
        ['madrugada de un día cuyo día anterior no tiene turno', local('2026-10-07', '01:00'), 'CLOSED'],
        ['madrugada tras el cierre, con turno el día anterior', local('2026-10-06', '03:00'), 'OUTSIDE_HOURS'],
    ])('cruce de medianoche: %s', (_n, dt, expected) => {
        const i = inputs({ opening_hours: { mon: { open: '20:00', close: '02:00' } } });
        expect(check(i, dt)).toBe(expected);
    });

    it('cruce de medianoche: lo reservado antes de las 00:00 ocupa mesas después de las 00:00', () => {
        const i = inputs(
            { opening_hours: { mon: { open: '20:00', close: '02:00' } }, capacity: 10 },
            { reservations: [{ date_time: local('2026-10-05', '23:30').toISOString(), party_size: 10 }] }
        );
        expect(check(i, local('2026-10-06', '00:30'), 2)).toBe('NO_AVAILABILITY'); // 23:30 + 90 min = 01:00
        expect(check(i, local('2026-10-06', '01:00'), 2)).toBe('OK');
    });

    it('restaurante inactivo', () => {
        expect(check(inputs({ is_active: false }), local('2026-10-05', '12:30'))).toBe('RESTAURANT_INACTIVE');
    });
});

describe('horas pasadas', () => {
    it('hoy, un horario que ya pasó', () => {
        const now = new Date('2026-10-05T16:00:00Z'); // 13:00 local
        expect(check(inputs(), local('2026-10-05', '12:30'), 2, now)).toBe('PAST');
    });
    it('hoy, un horario que aún no llega', () => {
        const now = new Date('2026-10-05T16:00:00Z'); // 13:00 local
        expect(check(inputs(), local('2026-10-05', '14:00'), 2, now)).toBe('OK');
    });
    it('un día anterior en horario de atención', () => {
        expect(check(inputs(), local('2026-10-02', '12:30'))).toBe('PAST'); // viernes pasado
    });
    it('un día anterior cerrado también es PAST (como el caso real: sábado 15:00 ya pasado)', () => {
        const now = new Date('2026-10-04T02:21:00Z'); // sábado 23:21 local
        expect(check(inputs(), local('2026-10-03', '15:00'), 2, now)).toBe('PAST');
    });
    it('hoy después del cierre pidiendo una hora de la noche = fuera de horario, no "cerrado"', () => {
        const now = new Date('2026-10-05T20:00:00Z'); // 17:00 local
        expect(check(inputs(), local('2026-10-05', '18:00'), 2, now)).toBe('OUTSIDE_HOURS');
    });
});

describe('disponibilidad de mesas', () => {
    const res = (day: string, hhmm: string, n: number) => ({ date_time: local(day, hhmm).toISOString(), party_size: n });

    it('sin cupo: capacidad copada en ese horario', () => {
        const i = inputs({ capacity: 10 }, { reservations: [res('2026-10-05', '12:30', 10)] });
        expect(check(i, local('2026-10-05', '12:30'), 1)).toBe('NO_AVAILABILITY');
    });
    it('queda cupo parcial: acepta hasta lo que queda, no más', () => {
        const i = inputs({ capacity: 10 }, { reservations: [res('2026-10-05', '12:30', 7)] });
        expect(check(i, local('2026-10-05', '12:30'), 3)).toBe('OK');
        expect(check(i, local('2026-10-05', '12:30'), 4)).toBe('NO_AVAILABILITY');
    });
    it('una reserva solapada (90 min) ocupa los horarios que se pisan, no los siguientes', () => {
        const i = inputs({ capacity: 4 }, { reservations: [res('2026-10-05', '12:30', 4)] });
        expect(check(i, local('2026-10-05', '13:30'), 1)).toBe('NO_AVAILABILITY'); // se solapa
        expect(check(i, local('2026-10-05', '14:00'), 1)).toBe('OK');              // la anterior ya terminó
    });
    it('los bloqueos activos reducen la capacidad', () => {
        const blocks = [{ start_time: local('2026-10-05', '12:00').toISOString(), end_time: local('2026-10-05', '14:00').toISOString(), blocked_slots: 8 }];
        const i = inputs({ capacity: 10 }, { blocks });
        expect(check(i, local('2026-10-05', '12:30'), 2)).toBe('OK');
        expect(check(i, local('2026-10-05', '12:30'), 3)).toBe('NO_AVAILABILITY');
    });
    it('bloqueo total', () => {
        const blocks = [{ start_time: local('2026-10-05', '12:00').toISOString(), end_time: local('2026-10-05', '16:00').toISOString(), blocked_slots: 999 }];
        expect(check(inputs({ capacity: 10 }, { blocks }), local('2026-10-05', '12:30'), 1)).toBe('NO_AVAILABILITY');
    });
    it('space_capacities (suma) manda sobre capacity, igual que la pantalla', () => {
        const i = inputs({ capacity: 100, space_capacities: { salon: 4, terraza: 2 } }, { reservations: [res('2026-10-05', '12:30', 6)] });
        expect(check(i, local('2026-10-05', '12:30'), 1)).toBe('NO_AVAILABILITY');
    });
    it('sin capacity ni space_capacities, usa 50 como la pantalla', () => {
        const i = inputs({ capacity: null }, { reservations: [res('2026-10-05', '12:30', 49)] });
        expect(check(i, local('2026-10-05', '12:30'), 1)).toBe('OK');
        expect(check(i, local('2026-10-05', '12:30'), 2)).toBe('NO_AVAILABILITY');
    });
});

describe('datos inválidos', () => {
    it.each([
        ['fecha inválida', new Date('nope'), 2],
        ['0 personas', local('2026-10-05', '12:30'), 0],
        ['personas NaN', local('2026-10-05', '12:30'), NaN],
    ])('%s', (_n, dt, party) => {
        expect(check(inputs(), dt as Date, party as number)).toBe('INVALID_DATE');
    });
});

describe('la pantalla y el servidor ofrecen lo mismo', () => {
    it('todo horario que ofrece la pantalla y está libre es aceptado; ninguno otro', () => {
        const i = inputs();
        for (const day of ['2026-10-05', '2026-10-07', '2026-10-08', '2026-10-10']) {
            const offered = new Set(computeDailySlots(i, day, 2, NOW).slots.filter((s) => s.available).map((s) => s.start.getTime()));
            // Barrido cada 10 min de todo el día: solo los horarios ofrecidos pasan.
            for (let m = 0; m < 24 * 60; m += 10) {
                const dt = new Date(local(day, '00:00').getTime() + m * 60000);
                const ok = evaluateReservationSlot(i, dt, 2, NOW).ok;
                expect(ok).toBe(offered.has(dt.getTime()));
            }
        }
    });
});

describe('pantalla de disponibilidad (computeDailySlots)', () => {
    const times = (i: DayInputs, day: string, now = NOW, party = 2) => computeDailySlots(i, day, party, now).slots.map((s) => s.time);

    it('grilla exacta de 30 min dentro del turno, sin el horario de cierre', () => {
        expect(times(inputs(), '2026-10-06')).toEqual(['12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30']);
    });

    it('hoy no ofrece horarios que ya pasaron, y sí el que cae exactamente ahora', () => {
        const at1330 = local('2026-10-05', '13:30'); // lunes
        expect(times(inputs(), '2026-10-05', at1330)).toEqual(['13:30', '14:00', '14:30', '15:00', '15:30']);
        expect(times(inputs(), '2026-10-05', new Date(at1330.getTime() + 1))).toEqual(['14:00', '14:30', '15:00', '15:30']);
    });

    it('un horario exactamente en este instante se acepta; un milisegundo antes ya pasó', () => {
        const slot = local('2026-10-05', '13:30');
        expect(check(inputs(), slot, 2, slot)).toBe('OK');
        expect(check(inputs(), slot, 2, new Date(slot.getTime() + 1))).toBe('PAST');
    });

    it('restaurante inactivo no ofrece nada', () => {
        expect(computeDailySlots(inputs({ is_active: false }), '2026-10-06', 2, NOW)).toEqual({ isClosed: true, slots: [] });
    });

    it('sin slot_duration usa 90 min', () => {
        const i = inputs({ slot_duration: null, capacity: 10 }, { reservations: [{ date_time: local('2026-10-06', '12:00').toISOString(), party_size: 10 }] });
        const byTime = Object.fromEntries(computeDailySlots(i, '2026-10-06', 1, NOW).slots.map((s) => [s.time, s.available]));
        expect(byTime['13:00']).toBe(false); // 12:00 + 90 min = 13:30 pisa 13:00
        expect(byTime['13:30']).toBe(true);
    });

    it('con el restaurante lleno, ningún horario está disponible ni para 0 personas', () => {
        const i = inputs({ capacity: 4 }, { reservations: [{ date_time: local('2026-10-06', '12:00').toISOString(), party_size: 4 }] });
        expect(computeDailySlots(i, '2026-10-06', 0, NOW).slots[0].available).toBe(false);
    });

    it('turno 00:00-00:00 = 24 horas (comportamiento de la rutina original)', () => {
        const i = inputs({ opening_hours: { mon: { open: '00:00', close: '00:00' } } });
        expect(times(i, '2026-10-12', NOW)).toHaveLength(48);
    });
});

describe('loadDayInputs: qué reservas ocupan mesa', () => {
    it('cuenta PENDIENTE, CONFIRMADA, CHECK-IN CLIENTE y COMPLETADA, de una ventana de ±1 día', async () => {
        const calls: Record<string, any[]> = {};
        const chain = (table: string) => {
            const rec: any[] = (calls[table] = []);
            const q: any = new Proxy({}, {
                get: (_t, prop: string) => {
                    if (prop === 'then') return (res: any) => res({ data: [], error: null });
                    if (prop === 'single') return () => Promise.resolve({ data: { slot_duration: 90 }, error: null });
                    return (...args: any[]) => { rec.push([prop, ...args]); return q; };
                },
            });
            return q;
        };
        await loadDayInputs({ from: chain } as any, 'r1', '2026-10-06');
        const inCall = calls.reservations.find((c) => c[0] === 'in');
        expect(inCall[2]).toEqual(['PENDIENTE', 'CONFIRMADA', 'CHECK-IN CLIENTE', 'COMPLETADA']);
        const gte = calls.reservations.find((c) => c[0] === 'gte')[2] as string;
        const lte = calls.reservations.find((c) => c[0] === 'lte')[2] as string;
        expect(new Date(gte).getTime()).toBeLessThanOrEqual(local('2026-10-05', '00:00').getTime());
        expect(new Date(lte).getTime()).toBeGreaterThanOrEqual(local('2026-10-07', '23:59').getTime());
    });
});

describe('Mesa liberada: la completada deja de ocupar desde que se libera', () => {
    const completed = (released_at: string | null = null) => ({ date_time: local('2026-10-05', '12:00').toISOString(), party_size: 70, released_at });
    const at = (hhmm: string) => local('2026-10-05', hhmm);

    it('reservationOccupiedUntil: el fin del turno, o antes si se liberó', () => {
        const start = local('2026-10-05', '12:00');
        expect(reservationOccupiedUntil(start, 90)).toBe(local('2026-10-05', '13:30').getTime());
        expect(reservationOccupiedUntil(start, 90, null)).toBe(local('2026-10-05', '13:30').getTime());
        expect(reservationOccupiedUntil(start, 90, local('2026-10-05', '12:10').toISOString())).toBe(local('2026-10-05', '12:10').getTime());
        // liberada después de que terminó el turno: manda el fin del turno
        expect(reservationOccupiedUntil(start, 90, local('2026-10-05', '14:00').toISOString())).toBe(local('2026-10-05', '13:30').getTime());
        // valor inválido: se ignora
        expect(reservationOccupiedUntil(start, 90, 'no-es-fecha')).toBe(local('2026-10-05', '13:30').getTime());
    });
    it('sin liberar, la completada ocupa todo su turno (no cambia nada)', () => {
        const i = inputs({}, { reservations: [completed()] });
        expect(check(i, at('12:30'), 10)).toBe('NO_AVAILABILITY');
        expect(check(i, at('13:00'), 10)).toBe('NO_AVAILABILITY');
        expect(check(i, at('13:30'), 10)).toBe('OK');
    });
    it('liberada a las 12:10: una reserva que empieza a las 12:30 ya cabe', () => {
        const i = inputs({}, { reservations: [completed(local('2026-10-05', '12:10').toISOString())] });
        expect(check(i, at('12:30'), 10)).toBe('OK');
        expect(check(i, at('13:00'), 10)).toBe('OK');
    });
    it('liberada a las 12:10: una que empieza antes de liberarse sigue chocando (la mesa estuvo ocupada)', () => {
        const i = inputs({}, { reservations: [completed(local('2026-10-05', '12:10').toISOString())] });
        expect(check(i, at('12:00'), 10)).toBe('NO_AVAILABILITY');
    });
    it('la pantalla de horarios (computeDailySlots) refleja lo mismo', () => {
        const day = (released: string | null) =>
            computeDailySlots(inputs({}, { reservations: [completed(released)] }), '2026-10-05', 10, NOW).slots.map((s) => [s.time, s.available]);
        const sinLiberar = Object.fromEntries(day(null));
        const liberada = Object.fromEntries(day(local('2026-10-05', '12:10').toISOString()));
        expect(sinLiberar['12:30']).toBe(false);
        expect(liberada['12:30']).toBe(true);
        expect(liberada['12:00']).toBe(false);
    });
});

describe('loadDayInputs: lee la liberación de la mesa', () => {
    it('trae metadata y la entrega como released_at (null si no hay)', async () => {
        const rows = [
            { date_time: '2026-10-06T16:00:00Z', party_size: 4, metadata: { table_released: { at: '2026-10-06T16:10:00Z' } } },
            { date_time: '2026-10-06T17:00:00Z', party_size: 2, metadata: null },
            { date_time: '2026-10-06T18:00:00Z', party_size: 3, metadata: { otra: 1 } },
        ];
        const selects: string[] = [];
        const chain = (table: string) => {
            const q: any = new Proxy({}, {
                get: (_t, prop: string) => {
                    if (prop === 'then') return (res: any) => res({ data: table === 'reservations' ? rows : [], error: null });
                    if (prop === 'single') return () => Promise.resolve({ data: { slot_duration: 90 }, error: null });
                    return (...args: any[]) => { if (table === 'reservations' && prop === 'select') selects.push(args[0]); return q; };
                },
            });
            return q;
        };
        const out = await loadDayInputs({ from: chain } as any, 'r1', '2026-10-06');
        expect(selects[0]).toContain('metadata');
        expect(out.reservations.map((r) => r.released_at)).toEqual(['2026-10-06T16:10:00Z', null, null]);
        expect(out.reservations.map((r) => r.party_size)).toEqual([4, 2, 3]);
    });
});

describe('intervalo entre horarios configurable', () => {
    const times = (over: Partial<SlotRestaurant>) =>
        computeDailySlots(inputs(over), '2026-10-05', 2, NOW).slots.map((s) => s.time);

    it('sin configurar (o nulo) la grilla es de 30 min', () => {
        expect(times({}).slice(0, 4)).toEqual(['12:00', '12:30', '13:00', '13:30']);
        expect(times({ slot_interval_minutes: null }).slice(0, 3)).toEqual(['12:00', '12:30', '13:00']);
    });
    it.each([
        [10, ['12:00', '12:10', '12:20', '12:30'], 24],
        [15, ['12:00', '12:15', '12:30', '12:45'], 16],
        [30, ['12:00', '12:30', '13:00', '13:30'], 8],
        [60, ['12:00', '13:00', '14:00', '15:00'], 4],
    ])('cada %i min', (step, first, count) => {
        const t = times({ slot_interval_minutes: step });
        expect(t.slice(0, 4)).toEqual(first);
        expect(t).toHaveLength(count);
        expect(t[t.length - 1] < '16:00').toBe(true);
    });
    it('un valor no permitido vuelve a 30 min', () => {
        for (const bad of [0, 7, 45, -15, '20', NaN]) expect(times({ slot_interval_minutes: bad as number }).slice(0, 3), String(bad)).toEqual(['12:00', '12:30', '13:00']);
    });
    it('la validación acepta solo horas de la grilla configurada', () => {
        const i15 = inputs({ slot_interval_minutes: 15 });
        expect(check(i15, local('2026-10-05', '12:45'))).toBe('OK');
        expect(check(i15, local('2026-10-05', '12:50'))).toBe('OUTSIDE_HOURS');
        const i60 = inputs({ slot_interval_minutes: 60 });
        expect(check(i60, local('2026-10-05', '13:00'))).toBe('OK');
        expect(check(i60, local('2026-10-05', '13:30'))).toBe('OUTSIDE_HOURS');
        expect(check(inputs(), local('2026-10-05', '12:15'))).toBe('OUTSIDE_HOURS');
    });
    it('la ocupación se calcula por solape de tiempo, no por grilla (reserva fuera de la grilla nueva)', () => {
        const i = inputs({ slot_interval_minutes: 60, capacity: 4 }, { reservations: [{ date_time: local('2026-10-05', '12:30').toISOString(), party_size: 4 }] });
        const day = computeDailySlots(i, '2026-10-05', 2, NOW);
        expect(day.slots.find((s) => s.time === '12:00')?.available).toBe(false);
        expect(day.slots.find((s) => s.time === '14:00')?.available).toBe(true);
    });
});

// ---------- Ventana de reservas (restaurants.reservation_hours ∩ opening_hours; migración 045b) ----------
describe('ventana de reservas', () => {
    const win = (reservation_hours: unknown, over: Partial<SlotRestaurant> = {}) => inputs({ reservation_hours, ...over });
    const W = { monday: [{ open: '13:00', close: '15:00' }] };

    it('sin ventana (null) no cambia nada', () => {
        expect(check(win(null), local('2026-10-05', '12:30'))).toBe('OK');
        expect(check(win(undefined), local('2026-10-05', '15:30'))).toBe('OK');
    });

    it.each([
        ['dentro de la ventana', local('2026-10-05', '13:00'), 'OK'],
        ['último horario de la ventana', local('2026-10-05', '14:30'), 'OK'],
        ['justo al cierre de la ventana (excluido)', local('2026-10-05', '15:00'), 'OUTSIDE_RESERVATION_WINDOW'],
        ['abierto pero antes de la ventana', local('2026-10-05', '12:30'), 'OUTSIDE_RESERVATION_WINDOW'],
        ['fuera de la atención y de la ventana', local('2026-10-05', '16:30'), 'OUTSIDE_HOURS'],
        ['martes: la ventana no lo menciona = sin reservas (no hereda)', local('2026-10-06', '13:00'), 'OUTSIDE_RESERVATION_WINDOW'],
        ['sábado: la atención está cerrada', local('2026-10-10', '13:00'), 'CLOSED'],
    ])('%s', (_n, dt, expected) => {
        expect(check(win(W), dt)).toBe(expected);
    });

    it('la ventana nunca amplía la atención', () => {
        const i = win({ monday: [{ open: '10:00', close: '20:00' }], saturday: [{ open: '13:00', close: '14:00' }] });
        expect(check(i, local('2026-10-05', '11:00'))).toBe('OUTSIDE_HOURS');   // lunes atiende 12-16
        expect(check(i, local('2026-10-05', '12:00'))).toBe('OK');
        expect(check(i, local('2026-10-05', '16:00'))).toBe('OUTSIDE_HOURS');
        expect(check(i, local('2026-10-10', '13:00'))).toBe('CLOSED');           // sábado sin atención
    });

    it('día cerrado en la ventana = sin reservas aunque atienda', () => {
        expect(check(win({ monday: [{ is_closed: true }] }), local('2026-10-05', '13:00'))).toBe('OUTSIDE_RESERVATION_WINDOW');
    });

    it('varios turnos en la ventana: nada entre medio', () => {
        const i = win({ monday: [{ open: '12:00', close: '13:00' }, { open: '15:00', close: '16:00' }] });
        expect(check(i, local('2026-10-05', '12:30'))).toBe('OK');
        expect(check(i, local('2026-10-05', '14:00'))).toBe('OUTSIDE_RESERVATION_WINDOW');
        expect(check(i, local('2026-10-05', '15:30'))).toBe('OK');
    });

    it('la grilla se cuenta desde la apertura del turno de la ventana', () => {
        const i = win({ monday: [{ open: '12:10', close: '14:00' }] }, { slot_interval_minutes: 30 });
        expect(check(i, local('2026-10-05', '12:10'))).toBe('OK');
        expect(check(i, local('2026-10-05', '12:40'))).toBe('OK');
        expect(check(i, local('2026-10-05', '12:30'))).toBe('OUTSIDE_RESERVATION_WINDOW'); // está en la atención, no en la grilla de la ventana
        const day = computeDailySlots(i, '2026-10-05', 2, NOW);
        expect(day.slots.map((s) => s.time)).toEqual(['12:10', '12:40', '13:10', '13:40']);
    });

    it('ventana que abre antes que la atención: la grilla parte de la ventana y se recorta a la atención', () => {
        const i = win({ monday: [{ open: '11:10', close: '16:00' }] }, { slot_interval_minutes: 30 });
        const times = computeDailySlots(i, '2026-10-05', 2, NOW).slots.map((s) => s.time);
        expect(times[0]).toBe('12:10'); // 11:10, 11:40 caen antes de abrir; el primero dentro de la atención es 12:10
    });

    it('turno que cruza la medianoche', () => {
        const i = win({ monday: [{ open: '22:00', close: '01:00' }] }, { opening_hours: { mon: { open: '20:00', close: '02:00' } } });
        expect(check(i, local('2026-10-05', '21:30'))).toBe('OUTSIDE_RESERVATION_WINDOW');
        expect(check(i, local('2026-10-05', '22:00'))).toBe('OK');
        expect(check(i, local('2026-10-06', '00:30'))).toBe('OK');
        expect(check(i, local('2026-10-06', '01:00'))).toBe('OUTSIDE_RESERVATION_WINDOW');
    });

    it('computeDailySlots: noReservations distingue «sin reservas» de «cerrado»', () => {
        const i = win(W);
        expect(computeDailySlots(i, '2026-10-06', 2, NOW)).toMatchObject({ isClosed: true, noReservations: true });  // martes atiende
        expect(computeDailySlots(i, '2026-10-10', 2, NOW)).toMatchObject({ isClosed: true, noReservations: false }); // sábado cerrado
        expect(computeDailySlots(i, '2026-10-05', 2, NOW)).toMatchObject({ isClosed: false });
    });
});

describe('loadDayInputs: interruptor de la ventana', () => {
    const run = async (enabled: boolean | undefined, reservation_hours: unknown) => {
        const from = (table: string) => {
            const q: any = new Proxy({}, {
                get: (_t, prop: string) => {
                    if (prop === 'then') return (res: any) => res({ data: [], error: null });
                    if (prop === 'single') return () => Promise.resolve({ data: { slot_duration: 90, reservation_hours }, error: null });
                    if (prop === 'maybeSingle' && table === 'reservation_window_enforcement') return () => Promise.resolve({ data: enabled === undefined ? null : { enabled }, error: null });
                    return () => q;
                },
            });
            return q;
        };
        return (await loadDayInputs({ from } as any, 'r1', '2026-10-06')).restaurant.reservation_hours;
    };
    const W = { monday: [{ open: '13:00', close: '15:00' }] };
    it('encendido: entrega la ventana', async () => { expect(await run(true, W)).toEqual(W); });
    it('apagado: la ventana no se aplica (null)', async () => { expect(await run(false, W)).toBeNull(); });
    it('no se pudo leer el interruptor: no se aplica', async () => { expect(await run(undefined, W)).toBeNull(); });
    it('encendido sin ventana propia: null', async () => { expect(await run(true, null)).toBeNull(); });
});
