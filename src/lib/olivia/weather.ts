// Pronóstico del día para OlivIA, de Open-Meteo (gratis, sin clave). Solo se envían las coordenadas de Santiago centro:
// nunca datos de personas ni la ubicación de la persona. Cualquier falla devuelve null y OlivIA no habla del clima.
import type { WeatherForecast } from './rules';

export const SANTIAGO_COORDS = { lat: -33.4489, lng: -70.6693 };
const TIMEOUT_MS = 4000;

export function forecastUrl(date: string): string {
    const p = new URLSearchParams({
        latitude: String(SANTIAGO_COORDS.lat),
        longitude: String(SANTIAGO_COORDS.lng),
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
        hourly: 'temperature_2m,precipitation_probability',
        timezone: 'America/Santiago',
        start_date: date,
        end_date: date,
    });
    return `https://api.open-meteo.com/v1/forecast?${p.toString()}`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Convierte la respuesta de Open-Meteo en lo que usa OlivIA. null si falta lo esencial (máxima y mínima). */
export function parseForecast(json: any): WeatherForecast | null {
    const d = json?.daily;
    const tempMax = num(d?.temperature_2m_max?.[0]);
    const tempMin = num(d?.temperature_2m_min?.[0]);
    if (tempMax == null || tempMin == null) return null;
    const times: unknown = json?.hourly?.time;
    const idx = Array.isArray(times) ? times.findIndex(t => typeof t === 'string' && t.endsWith('T13:00')) : -1;
    return {
        tempMax,
        tempMin,
        temp13: idx >= 0 ? num(json.hourly.temperature_2m?.[idx]) : null,
        precipProbMax: num(d?.precipitation_probability_max?.[0]),
        precipProb13: idx >= 0 ? num(json.hourly.precipitation_probability?.[idx]) : null,
        precipSumMm: num(d?.precipitation_sum?.[0]),
    };
}

export async function fetchSantiagoForecast(date: string, fetchImpl: typeof fetch = fetch): Promise<WeatherForecast | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(forecastUrl(date), { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) return null;
        return parseForecast(await res.json());
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
