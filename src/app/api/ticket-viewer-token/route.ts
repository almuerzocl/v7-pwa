import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/utils/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isRelatedToTicket, signViewerToken, type TicketViewerKind } from "@/lib/ticket-viewer-token";

export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const noStore = { "Cache-Control": "no-store, max-age=0" };

let _admin: ReturnType<typeof createClient> | null = null;
function admin() {
    if (!_admin) {
        _admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
    }
    return _admin;
}

/**
 * POST /api/ticket-viewer-token  { kind: 'r' | 'o', code }
 * Responde { token } si el usuario con sesión está relacionado con ese ticket, o { token: null } en cualquier
 * otro caso (sin sesión, sin relación, no existe): public-tickets lo trata entonces como anónimo.
 * Nunca revela si el código existe.
 */
export async function POST(req: NextRequest) {
    try {
        const session = await createSessionClient();
        const { data: { user } } = await session.auth.getUser();
        if (!user) return NextResponse.json({ token: null }, { headers: noStore });

        if (!rateLimit(`tvt:${user.id}`, 30, 60_000).allowed) {
            return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: noStore });
        }

        const body = await req.json().catch(() => null);
        const kind = body?.kind as TicketViewerKind;
        const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
        if ((kind !== "r" && kind !== "o") || !CODE_RE.test(code)) {
            return NextResponse.json({ token: null }, { headers: noStore });
        }

        const table = kind === "r" ? "reservations" : "takeaway_orders";
        const columns = kind === "r" ? "organizer_id, user_id, guest_data, guests" : "user_id";
        const { data, error } = await (admin() as any).from(table).select(columns).eq("unique_code", code).limit(1);
        if (error) throw error;
        const row = (data as any[] | null)?.[0];
        if (!isRelatedToTicket(kind, row, user.id)) return NextResponse.json({ token: null }, { headers: noStore });

        const token = signViewerToken({ sub: user.id, code, kind }, process.env.TICKET_VIEWER_SECRET || "");
        return NextResponse.json({ token }, { headers: noStore });
    } catch (err: any) {
        // Falla hacia anónimo: el ticket igual se muestra, enmascarado.
        console.error("[ticket-viewer-token]", err?.message || err);
        return NextResponse.json({ token: null }, { headers: noStore });
    }
}
