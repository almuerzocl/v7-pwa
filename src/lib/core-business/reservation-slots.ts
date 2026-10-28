/**
 * ÚNICA fuente de qué horarios de reserva existen y cuáles tienen mesa.
 *
 * Lo usan (1) la pantalla de disponibilidad (`getRestaurantDailyAvailabilityAction`) y (2) la creación de la
 * reserva en el servidor (`validateReservationSlot`), para que lo que el cliente ve y lo que el servidor acepta
 * no puedan divergir. Antes la creación solo miraba el cupo (función SQL `create_reservation_atomic`) y aceptaba
 * reservas en días cerrados, fuera de horario y en horas pasadas.
 *
 * Reglas:
 *  - El restaurante debe estar activo (`is_active` distinto de false).
 *  - La hora pedida debe ser EXACTAMENTE un horario ofrecido: grilla de `slot_interval_minutes` (10, 15, 30 o 60;
 *    por defecto 30) dentro de un turno de `opening_hours` de ese día (día sin configuración o `is_closed` = cerrado).
 *  - Si el día es hoy (Santiago), los horarios ya pasados no se ofrecen ni se aceptan.
 *  - Debe haber mesa: capacidad (suma de `space_capacities`, o `capacity`, o 50) menos bloqueos activos,
 *    menos lo ya reservado que se solape durante `slot_duration`, ≥ personas pedidas.
 *  - Una reserva completada sigue ocupando la mesa todo su turno; si el restaurante marcó "Mesa liberada"
 *    (`metadata.table_released.at`), solo la ocupa hasta ese instante (mismo criterio que la migración 033 de la base).
 */
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { format } from 'date-fns';
import { TIMEZONE } from '@/lib/config';
import { getOpeningShiftsForDay, getReservationShiftsForDay, dayIndexForDateStr } from './restaurant-hours';

export interface SlotRestaurant {
    slot_duration: number | null;
    /** Cada cuántos minutos se ofrece un horario (columna restaurants.slot_interval_minutes). */
    slot_interval_minutes?: number | null;
    space_capacities: Record<string, unknown> | null;
    opening_hours: unknown;
    /** Ventana de reservas (restaurants.reservation_hours). `null`/ausente = la ventana es el horario de atención. `loadDayInputs` la deja en `null` mientras el interruptor de la base esté apagado. */
    reservation_hours?: unknown;
    capacity: number | null;
    is_active: boolean | null;
}
export interface SlotReservation { date_time: string; party_size: number; released_at?: string | null }

/** Instante (ms) hasta el que una reserva ocupa la mesa: el fin de su turno, o antes si el restaurante liberó la mesa. */
export function reservationOccupiedUntil(dateTime: string | Date, slotDurationMin: number, releasedAt?: string | null): number {
    const end = new Date(dateTime).getTime() + slotDurationMin * 60000;
    const released = releasedAt ? new Date(releasedAt).getTime() : NaN;
    return Number.isFinite(released) ? Math.min(end, released) : end;
}
export interface SlotBlock { start_time: string; end_time: string; blocked_slots: number }

export interface DayInputs {
    restaurant: SlotRestaurant;
    reservations: SlotReservation[];
    blocks: SlotBlock[];
}

export interface DailySlot {
    time: string;       // 'HH:mm' en hora de Santiago
    start: Date;
    available: boolean;
    occupied: number;
    totalCapacity: number;
}

export interface DailySlots {
    isClosed: boolean;
    /** El local atiende ese día pero la ventana de reservas no deja reservar (no es lo mismo que «cerrado»). */
    noReservations?: boolean;
    slots: DailySlot[];
}

/** Intervalos permitidos entre horarios ofrecidos (la base los exige con un CHECK). */
export const SLOT_INTERVALS = [10, 15, 30, 60] as const;
export const DEFAULT_SLOT_INTERVAL = 30;

/** Intervalo efectivo: el configurado si es válido; si falta o no es permitido, 30. */
export function resolveSlotInterval(value: unknown): number {
    const n = Number(value);
    return (SLOT_INTERVALS as readonly number[]).includes(n) ? n : DEFAULT_SLOT_INTERVAL;
}

/** Horarios del día con su disponibilidad. Puro: no toca la base. */
export function computeDailySlots(inputs: DayInputs, dateStr: string, partySize: number, now: Date = new Date()): DailySlots {
    const { restaurant, reservations, blocks } = inputs;
    if (restaurant.is_active === false) return { isClosed: true, slots: [] };

    const slotDuration = restaurant.slot_duration || 90;
    const STEP_MIN = resolveSlotInterval(restaurant.slot_interval_minutes);
    const spaceCapValues = restaurant.space_capacities ? Object.values(restaurant.space_capacities) : [];
    const spacesSum = spaceCapValues.reduce((a: number, b: unknown) => a + Number(b), 0);
    const totalCapacity = spacesSum > 0 ? spacesSum : (restaurant.capacity || 50);

    const dayIndex = dayIndexForDateStr(dateStr);
    const dayShifts = getReservationShiftsForDay(restaurant.opening_hours, restaurant.reservation_hours, dayIndex);
    if (dayShifts.length === 0) {
        return { isClosed: true, noReservations: getOpeningShiftsForDay(restaurant.opening_hours, dayIndex).length > 0, slots: [] };
    }

    const isToday = dateStr === format(toZonedTime(now, TIMEZONE), 'yyyy-MM-dd');
    const slots: DailySlot[] = [];

    dayShifts.forEach((shift) => {
        if (!shift.open || !shift.close || shift.is_closed) return;

        const startZoned = fromZonedTime(`${dateStr} ${shift.open}:00`, TIMEZONE);
        let endZoned = fromZonedTime(`${dateStr} ${shift.close}:00`, TIMEZONE);
        // Cruce de medianoche (p. ej. abre 20:00, cierra 02:00)
        if (endZoned <= startZoned) endZoned = new Date(endZoned.getTime() + 24 * 60 * 60 * 1000);

        // La grilla se cuenta desde la apertura del turno de la ventana (puede ser anterior al primer horario efectivo).
        let current = shift.grid_from ? fromZonedTime(`${dateStr} ${shift.grid_from}:00`, TIMEZONE) : startZoned;
        while (current < startZoned) current = new Date(current.getTime() + STEP_MIN * 60000);
        while (current < endZoned) {
            // Los horarios ya pasados no existen (solo aplica si la fecha es hoy)
            if (isToday && current < now) {
                current = new Date(current.getTime() + STEP_MIN * 60000);
                continue;
            }

            const slotEnd = new Date(current.getTime() + slotDuration * 60000);

            let occupied = 0;
            reservations.forEach((res) => {
                const resStart = new Date(res.date_time);
                const resEnd = new Date(reservationOccupiedUntil(resStart, slotDuration, res.released_at));
                if (resStart < slotEnd && resEnd > current) occupied += res.party_size;
            });

            let blocked = 0;
            blocks.forEach((block) => {
                if (new Date(block.start_time) < slotEnd && new Date(block.end_time) > current) blocked += block.blocked_slots;
            });

            const effectiveCapacity = Math.max(0, totalCapacity - blocked);
            const remaining = effectiveCapacity - occupied;

            slots.push({
                time: format(toZonedTime(current, TIMEZONE), 'HH:mm'),
                start: current,
                available: remaining >= 1 && remaining >= partySize,
                occupied,
                totalCapacity: effectiveCapacity,
            });
            current = new Date(current.getTime() + STEP_MIN * 60000);
        }
    });

    // Sin duplicados (turnos que se solapan) y ordenados
    const unique = Array.from(new Map(slots.map((s) => [s.time, s])).values()).sort((a, b) => a.time.localeCompare(b.time));
    return { isClosed: unique.length === 0, slots: unique };
}

// Cliente de Supabase mínimo que necesitamos (service role en el servidor).
type SupabaseLike = { from: (table: string) => any };

/** Lee de la base lo necesario para calcular los horarios de un día. */
export async function loadDayInputs(supabase: SupabaseLike, restaurantId: string, dateStr: string): Promise<DayInputs> {
    const { data: restaurant, error: restError } = await supabase
        .from('restaurants')
        .select('slot_duration, slot_interval_minutes, space_capacities, opening_hours, reservation_hours, capacity, is_active')
        .eq('id', restaurantId)
        .single();
    if (restError || !restaurant) throw new Error('Restaurante no encontrado');

    // Ventana de ±1 día: los turnos que cruzan la medianoche ven reservas del día anterior y del siguiente.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const startOfDay = new Date(fromZonedTime(`${dateStr} 00:00:00`, TIMEZONE).getTime() - DAY_MS).toISOString();
    const endOfDay = new Date(fromZonedTime(`${dateStr} 23:59:59`, TIMEZONE).getTime() + DAY_MS).toISOString();

    const [resResponse, blocksResponse, enforcement] = await Promise.all([
        supabase
            .from('reservations')
            .select('date_time, party_size, metadata')
            .eq('restaurant_id', restaurantId)
            .in('status', ['PENDIENTE', 'CONFIRMADA', 'CHECK-IN CLIENTE', 'COMPLETADA'])
            .gte('date_time', startOfDay)
            .lte('date_time', endOfDay),
        supabase
            .from('reservation_blocks')
            .select('start_time, end_time, blocked_slots')
            .eq('restaurant_id', restaurantId)
            .eq('is_active', true)
            .lte('start_time', endOfDay)
            .gte('end_time', startOfDay),
        // Interruptor global de la ventana (migración 045b). Apagado, o si no se puede leer, la ventana no se aplica: la base decide igual.
        supabase.from('reservation_window_enforcement').select('enabled').maybeSingle(),
    ]);
    if (resResponse.error) throw resResponse.error;
    if (blocksResponse.error) throw blocksResponse.error;

    const reservations: SlotReservation[] = (resResponse.data || []).map((r: { date_time: string; party_size: number; metadata?: { table_released?: { at?: string } } | null }) => ({
        date_time: r.date_time,
        party_size: r.party_size,
        released_at: r.metadata?.table_released?.at ?? null,
    }));
    const windowOn = (enforcement as { data?: { enabled?: boolean } | null } | undefined)?.data?.enabled === true;
    return {
        restaurant: { ...restaurant, reservation_hours: windowOn ? (restaurant.reservation_hours ?? null) : null },
        reservations,
        blocks: blocksResponse.data || [],
    };
}

export type SlotRejection = 'RESTAURANT_INACTIVE' | 'CLOSED' | 'PAST' | 'OUTSIDE_HOURS' | 'OUTSIDE_RESERVATION_WINDOW' | 'NO_AVAILABILITY' | 'INVALID_DATE';

export type SlotValidation = { ok: true } | { ok: false; code: SlotRejection; message: string };

export const MESSAGES: Record<SlotRejection, string> = {
    INVALID_DATE: 'La fecha u hora de la reserva no es válida.',
    RESTAURANT_INACTIVE: 'El restaurante no está recibiendo reservas.',
    CLOSED: 'El restaurante está cerrado ese día. Elige otra fecha.',
    PAST: 'Ese horario ya pasó. Elige uno futuro.',
    OUTSIDE_HOURS: 'Ese horario está fuera del horario de atención del restaurante. Elige otro.',
    OUTSIDE_RESERVATION_WINDOW: 'A esa hora el local está abierto pero no recibe reservas. Elige otro horario o llega sin reserva.',
    NO_AVAILABILITY: 'Ya no queda disponibilidad de mesas para ese horario. Elige otro.',
};

/** Decisión pura sobre si `dateTime` es un horario reservable (sin tocar la base). */
export function evaluateReservationSlot(inputs: DayInputs, dateTime: Date, partySize: number, now: Date = new Date()): SlotValidation {
    const fail = (code: SlotRejection): SlotValidation => ({ ok: false, code, message: MESSAGES[code] });
    if (Number.isNaN(dateTime.getTime()) || !Number.isFinite(partySize) || partySize < 1) return fail('INVALID_DATE');
    if (inputs.restaurant.is_active === false) return fail('RESTAURANT_INACTIVE');

    // Nada en el pasado, sea hoy o cualquier otro día.
    if (dateTime.getTime() < now.getTime()) return fail('PAST');

    // Un turno que cruza la medianoche (20:00-02:00) pertenece al día en que abre: sus horarios de madrugada
    // tienen fecha local del día siguiente. Se busca el horario en el día de la hora pedida y en el anterior.
    const dateStr = formatInTimeZone(dateTime, TIMEZONE, 'yyyy-MM-dd');
    const days = [dateStr, previousDateStr(dateStr)];

    // Sin filtrar horas pasadas: ¿hay algún horario ofrecido en esta fecha local (propio o de madrugada de un
    // turno del día anterior)? Si no, el restaurante está cerrado ese día.
    const offeredThatDate = days
        .flatMap((d) => computeDailySlots(inputs, d, partySize, new Date(0)).slots)
        .some((s) => formatInTimeZone(s.start, TIMEZONE, 'yyyy-MM-dd') === dateStr);
    if (!offeredThatDate) return fail(offeredByOpeningHours(inputs, days, dateStr) ? 'OUTSIDE_RESERVATION_WINDOW' : 'CLOSED');

    const matches = days
        .flatMap((d) => computeDailySlots(inputs, d, partySize, now).slots)
        .filter((s) => s.start.getTime() === dateTime.getTime());
    if (matches.length === 0) {
        const byOpening = days
            .flatMap((d) => computeDailySlots(withoutWindow(inputs), d, partySize, now).slots)
            .some((s) => s.start.getTime() === dateTime.getTime());
        return fail(inputs.restaurant.reservation_hours != null && byOpening ? 'OUTSIDE_RESERVATION_WINDOW' : 'OUTSIDE_HOURS');
    }
    if (!matches.some((s) => s.available)) return fail('NO_AVAILABILITY');
    return { ok: true };
}

function withoutWindow(inputs: DayInputs): DayInputs {
    return { ...inputs, restaurant: { ...inputs.restaurant, reservation_hours: null } };
}

/** ¿El horario de atención (sin ventana) ofrece algún horario en esa fecha local? Distingue «cerrado» de «sin reservas». */
function offeredByOpeningHours(inputs: DayInputs, days: string[], dateStr: string): boolean {
    if (inputs.restaurant.reservation_hours == null) return false;
    return days
        .flatMap((d) => computeDailySlots(withoutWindow(inputs), d, 1, new Date(0)).slots)
        .some((s) => formatInTimeZone(s.start, TIMEZONE, 'yyyy-MM-dd') === dateStr);
}

function previousDateStr(dateStr: string): string {
    return new Date(new Date(`${dateStr}T12:00:00Z`).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Valida en el servidor, antes de crear la reserva, que el horario existe y tiene mesa. */
export async function validateReservationSlot(
    supabase: SupabaseLike,
    params: { restaurantId: string; dateTime: string; partySize: number },
    now: Date = new Date()
): Promise<SlotValidation> {
    const dt = new Date(params.dateTime);
    if (Number.isNaN(dt.getTime())) return { ok: false, code: 'INVALID_DATE', message: MESSAGES.INVALID_DATE };
    const dateStr = formatInTimeZone(dt, TIMEZONE, 'yyyy-MM-dd');
    const inputs = await loadDayInputs(supabase, params.restaurantId, dateStr);
    return evaluateReservationSlot(inputs, dt, params.partySize, now);
}
