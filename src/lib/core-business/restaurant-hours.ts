/**
 * Single source of truth for resolving a restaurant's public opening hours.
 *
 * `opening_hours` (set exclusively by the restaurant dashboard's settings
 * form) is the only place a restaurant's schedule is stored. There is no
 * separate "operating hours" dataset — takeaway/pickup availability is a
 * derived view of opening_hours narrowed by `takeaway_settings.opening_offset`
 * / `closing_offset` (kitchen prep/cutoff time), computed at read time by
 * each caller. The legacy `operating_hours` column must never be read as an
 * independent data source.
 */

export interface RestaurantShift {
    open?: string;
    close?: string;
    is_closed?: boolean;
    /** Solo en los turnos de reserva: apertura del turno de la ventana, desde donde se cuenta la grilla de horarios. */
    grid_from?: string;
}

const SHORT_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LONG_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SPANISH_DAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/** Day-of-week index (0=Sunday) for a 'yyyy-MM-dd' date string, independent of server TZ. */
export function dayIndexForDateStr(dateStr: string): number {
    return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

function resolveDayConfig(config: any, dayIndex: number) {
    if (!config) return null;
    const shortKey = SHORT_DAYS[dayIndex];
    const longKey = LONG_DAYS[dayIndex];
    const spanishKey = SPANISH_DAYS[dayIndex];

    if (Array.isArray(config)) {
        return config.find((c: any) => {
            const d = (c.day || '').toLowerCase();
            return d === shortKey || d === longKey || d === spanishKey;
        }) || null;
    }
    if (typeof config !== 'object') return null;
    return config[shortKey] ??
        config[longKey] ??
        config[spanishKey] ??
        config[shortKey.toUpperCase()] ??
        config[longKey.charAt(0).toUpperCase() + longKey.slice(1)] ??
        config[spanishKey.charAt(0).toUpperCase() + spanishKey.slice(1)] ??
        null;
}

function normalizeShift(raw: any): RestaurantShift {
    const shift: RestaurantShift & { hours?: string } = { ...raw };
    if (typeof shift.is_closed === 'string') {
        shift.is_closed = shift.is_closed === 'true';
    }
    if (shift.hours && (!shift.open || !shift.close)) {
        const hours = shift.hours.toLowerCase();
        if (hours === 'cerrado' || hours === 'closed') {
            shift.is_closed = true;
        } else {
            const [open, close] = shift.hours.split('-').map((s: string) => s.trim());
            if (open && close) {
                shift.open = open;
                shift.close = close;
            }
        }
    }
    return shift;
}

/**
 * Resolves the public opening shift(s) for a given day of the week from
 * `opening_hours`. Returns an empty array when the restaurant is closed
 * that day (explicitly, or because no config exists).
 */
export function getOpeningShiftsForDay(openingHours: any, dayIndex: number): RestaurantShift[] {
    const rawConfig = resolveDayConfig(openingHours, dayIndex);
    if (!rawConfig) return [];

    const shifts = (Array.isArray(rawConfig) ? rawConfig : [rawConfig]).map(normalizeShift);
    if (shifts.length === 0 || shifts.every(s => s.is_closed)) return [];

    return shifts.filter(s => !s.is_closed && s.open && s.close);
}

const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};
const toHHmm = (min: number): string => {
    const m = ((min % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * Turnos en los que se aceptan reservas un día: la ventana de reservas (`restaurants.reservation_hours`) INTERSECTADA con el
 * horario de atención. La ventana nunca amplía la atención. Sin ventana (`null`/`undefined`) la ventana es la atención.
 *
 * Mismo cálculo que la regla de la base (`reservation_slot_rule`, migración 045b): un cierre menor o igual a la apertura cruza la
 * medianoche; cada turno resultante lleva `grid_from` = apertura del turno de la ventana (o de la atención si no hay ventana),
 * y la grilla de horarios se cuenta desde ahí. Un día ausente o cerrado en la ventana no admite reservas (no hereda).
 */
export function getReservationShiftsForDay(openingHours: any, reservationHours: any, dayIndex: number): RestaurantShift[] {
    const opening = getOpeningShiftsForDay(openingHours, dayIndex);
    if (reservationHours == null) return opening;
    const windows = getOpeningShiftsForDay(reservationHours, dayIndex);
    const span = (s: RestaurantShift): [number, number] => {
        const a = toMinutes(s.open as string);
        const b = toMinutes(s.close as string);
        return [a, b <= a ? b + 1440 : b];
    };
    const out: RestaurantShift[] = [];
    for (const o of opening) {
        const [os, oe] = span(o);
        for (const w of windows) {
            const [ws, we] = span(w);
            const lo = Math.max(os, ws);
            const hi = Math.min(oe, we);
            if (lo < hi) out.push({ open: toHHmm(lo), close: toHHmm(hi), grid_from: w.open });
        }
    }
    return out;
}
