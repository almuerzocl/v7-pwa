import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient as createSessionClient } from '@/utils/supabase/server';
import { getSupabaseAdmin } from '@/lib/server/supabase-admin';
import { handleOliviaChat, type ModelCall } from '@/lib/olivia/chat';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * OlivIA (asistente de almuerzo). La clave de Anthropic vive solo en el servidor (Secret Manager -> ANTHROPIC_API_KEY).
 * La sesión se valida con auth.getUser(): el usuario sale de la sesión, nunca del cuerpo. El tope diario (3) y el gasto mensual
 * (USD 5) los aplica la base (migración 043). OlivIA solo recomienda: nunca pide, reserva ni envía nada por su cuenta.
 */
const callAnthropic: ModelCall = async ({ model, system, messages, maxTokens }) => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const res = await client.messages.create({ model, max_tokens: maxTokens, thinking: { type: 'disabled' }, system, messages }, { timeout: 25_000, maxRetries: 1 });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
    return { text, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
};

export async function POST(req: NextRequest) {
    let body: unknown = null;
    try { body = await req.json(); } catch { /* cuerpo vacío o inválido: lo rechaza handleOliviaChat */ }

    let userId: string | null = null;
    try {
        const session = await createSessionClient();
        const { data: { user } } = await session.auth.getUser();
        userId = user?.id ?? null;
    } catch {
        userId = null;
    }

    if (userId && !process.env.ANTHROPIC_API_KEY) {
        console.error('[olivia] falta ANTHROPIC_API_KEY en el servidor');
        return NextResponse.json({ error: 'OlivIA no está disponible en este momento. Puedes seguir con la búsqueda normal.', code: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    const result = await handleOliviaChat({ userId, body }, { admin: getSupabaseAdmin(), callModel: callAnthropic });
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
