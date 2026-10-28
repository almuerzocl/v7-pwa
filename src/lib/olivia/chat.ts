// OlivIA: una consulta de punta a punta. Todo lo externo (base, modelo, red, hora) entra por `deps` para probarlo sin llamar a nadie.
// Orden: validar entrada -> reservar el cupo en la base (tope diario y gasto mensual) -> armar contexto desde las copias del día
// -> llamar al modelo -> cerrar el cupo con los tokens reales. Si el modelo falla, el cupo queda 'fallida' y no se descuenta.
// Nunca se registra el texto de la persona ni la respuesta: solo códigos y conteos.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    SYSTEM_PROMPT, buildContext, haversineKm, normalizeMessages, parseLocation, parseModelReply,
    type OfferSnapshot, type VenuesSnapshot, type WeatherForecast, type LatLng,
} from './rules';
import { getSnapshot } from './snapshots';
import { getUserHistory } from './history';

export type OliviaUsage = { daily_limit: number; used: number; remaining: number; resets_at: string };

export type OliviaRecommendation = {
    id: string; name: string; comuna: string; reason: string; distanceKm: number | null; href: string; canOrder: boolean; canReserve: boolean;
};

export type OliviaResult =
    | { status: 200; body: { reply: string; needsLocation: boolean; recommendations: OliviaRecommendation[]; usage: OliviaUsage } }
    | { status: 400 | 401 | 429 | 502 | 503; body: { error: string; code: string; usage?: OliviaUsage } };

export type ModelCall = (args: { model: string; system: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens: number }) =>
    Promise<{ text: string; inputTokens: number; outputTokens: number }>;

export type OliviaDeps = {
    admin: SupabaseClient<any>;
    callModel: ModelCall;
    now?: Date;
    fetchImpl?: typeof fetch;
};

const MAX_OUTPUT_TOKENS = 700;

const usageOf = (r: any): OliviaUsage => ({ daily_limit: r.daily_limit, used: r.used, remaining: r.remaining, resets_at: r.resets_at });

export async function handleOliviaChat(input: { userId: string | null; body: unknown }, deps: OliviaDeps): Promise<OliviaResult> {
    const { admin } = deps;
    const now = deps.now ?? new Date();

    if (!input.userId) return { status: 401, body: { error: 'Inicia sesión para hablar con OlivIA.', code: 'unauthenticated' } };

    const raw = (input.body ?? {}) as any;
    const messages = normalizeMessages(raw.messages);
    if (!messages) return { status: 400, body: { error: 'Escribe tu consulta para que OlivIA pueda ayudarte.', code: 'bad_request' } };
    const location: LatLng | null = parseLocation(raw.location);

    // 1. Cupo (tope diario y gasto mensual): la regla vive en la base, con candado por usuario.
    const { data: reservedRaw, error: reserveError } = await admin.rpc('olivia_reserve', { p_user: input.userId, p_now: now.toISOString() });
    if (reserveError || !reservedRaw) {
        console.error('[olivia] no se pudo reservar el cupo:', reserveError?.message);
        return { status: 503, body: { error: 'OlivIA no está disponible en este momento. Puedes seguir con la búsqueda normal.', code: 'unavailable' } };
    }
    const reserved = reservedRaw as any;
    if (!reserved.ok) {
        if (reserved.code === 'limit_reached') {
            return { status: 429, body: { error: 'Usaste tus consultas de hoy. Vuelven mañana; mientras tanto puedes seguir con la búsqueda normal.', code: 'limit_reached', usage: usageOf(reserved) } };
        }
        // 'disabled', 'no_user' y 'budget_exhausted' se muestran igual de simple: sin detalles de costos al cliente.
        return { status: 503, body: { error: 'OlivIA no está disponible en este momento. Puedes seguir con la búsqueda normal.', code: reserved.code === 'budget_exhausted' ? 'budget_exhausted' : 'unavailable' } };
    }

    const finish = (status: 'ok' | 'fallida', inTok = 0, outTok = 0) =>
        admin.rpc('olivia_finish', { p_id: reserved.id, p_status: status, p_input: inTok, p_output: outTok })
            .then(r => { if (r.error) console.error('[olivia] no se pudo cerrar la consulta:', r.error.message); });

    try {
        // 2. Contexto: copias del día (baratas, compartidas por todos) + historial propio.
        const [offerRes, venuesRes, weatherRes, history] = await Promise.all([
            getSnapshot<OfferSnapshot>(admin, 'offer', { now, fetchImpl: deps.fetchImpl }),
            getSnapshot<VenuesSnapshot>(admin, 'venues', { now, fetchImpl: deps.fetchImpl }),
            getSnapshot<WeatherForecast>(admin, 'weather', { now, fetchImpl: deps.fetchImpl }),
            getUserHistory(admin, input.userId, now),
        ]);
        const context = buildContext({
            now, offer: offerRes.data, offerBuiltAt: offerRes.builtAt, venues: venuesRes.data, weather: weatherRes.data, history, location,
        });

        // 3. Modelo (el prompt de reglas va en system; los datos van aparte y marcados como datos).
        const model = String(reserved.model || 'claude-haiku-5-5');
        const out = await deps.callModel({
            model,
            system: `${SYSTEM_PROMPT}\n\n${context}`,
            messages,
            maxTokens: MAX_OUTPUT_TOKENS,
        });
        await finish('ok', out.inputTokens, out.outputTokens);

        // 4. Respuesta: solo se aceptan ids de locales que están en la copia (el modelo no puede inventar ni mandar a otro lado).
        const parsed = parseModelReply(out.text);
        const venues = new Map((venuesRes.data?.restaurants ?? []).map(v => [v.id, v]));
        const seen = new Set<string>();
        const recommendations: OliviaRecommendation[] = [];
        for (const p of parsed.picks) {
            const v = venues.get(p.id);
            if (!v || seen.has(v.id)) continue;
            seen.add(v.id);
            recommendations.push({
                id: v.id, name: v.name, comuna: v.comuna, reason: p.reason,
                distanceKm: location && v.lat != null && v.lng != null ? Math.round(haversineKm(location, { lat: v.lat, lng: v.lng }) * 10) / 10 : null,
                href: `/restaurant/${v.id}`, canOrder: v.hasTakeaway, canReserve: v.hasReservations,
            });
        }
        return { status: 200, body: { reply: parsed.reply, needsLocation: parsed.needsLocation && !location, recommendations, usage: usageOf(reserved) } };
    } catch (e) {
        await finish('fallida');
        console.error('[olivia] la consulta falló:', (e as Error).message);
        return {
            status: 502,
            body: { error: 'OlivIA no pudo responder ahora. Esta consulta no se descontó; intenta de nuevo en un momento.', code: 'model_error', usage: { ...usageOf(reserved), used: reserved.used - 1, remaining: reserved.remaining + 1 } },
        };
    }
}
