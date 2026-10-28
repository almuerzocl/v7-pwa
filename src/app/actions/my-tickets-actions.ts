"use server";

// Lecturas de reservas/pedidos del usuario desde el servidor (service_role), con la sesión validada por
// auth.getUser(). Reemplazan las consultas del navegador que dependían de la policy "Authenticated access by
// unique_code" (migración 030). La relación con el ticket la decide `isRelatedToTicket`, la misma regla del token
// de visor; nunca la sesión del navegador ni un uid enviado por el cliente.
import { createClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/utils/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { guestMatchesContact, isRelatedToTicket, ticketGuests } from "@/lib/ticket-viewer-token";

let _admin: ReturnType<typeof createClient> | null = null;
function admin() {
    if (!_admin) {
        _admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
    }
    return _admin as any;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const NOT_FOUND = "not_found";

async function currentUser() {
    const session = await createSessionClient();
    const { data: { user } } = await session.auth.getUser();
    return user;
}

async function readOwnedTicket(kind: "r" | "o", idOrCode: string): Promise<{ data?: any; error?: string }> {
    const user = await currentUser();
    if (!user) return { error: "unauthenticated" };
    if (!rateLimit(`tk-read:${user.id}`, 60, 60_000).allowed) return { error: "rate_limited" };

    const value = typeof idOrCode === "string" ? idOrCode.trim() : "";
    const byId = UUID_RE.test(value);
    const code = value.toUpperCase();
    if (!byId && !CODE_RE.test(code)) return { error: NOT_FOUND };

    const table = kind === "r" ? "reservations" : "takeaway_orders";
    const select = kind === "r"
        ? "*, restaurant:restaurants(name, address, id, logo_url, phone)"
        : "*, restaurant:restaurants(name, address, id, logo_url)";
    const q = admin().from(table).select(select);
    const { data, error } = await (byId ? q.eq("id", value) : q.eq("unique_code", code)).limit(1);
    if (error) return { error: "fetch_failed" };
    const row = data?.[0];
    // Mismo mensaje para "no existe" y "no es tuyo": no revela si el código existe.
    if (!row || !isRelatedToTicket(kind, row, user.id)) return { error: NOT_FOUND };
    return { data: row };
}

export async function getReservationForViewerAction(idOrCode: string) {
    return readOwnedTicket("r", idOrCode);
}

export async function getOrderForViewerAction(idOrCode: string) {
    return readOwnedTicket("o", idOrCode);
}

const RESERVATION_SELECT = "*, restaurant:restaurants(name, address, id)";

/**
 * "Mis reservas": organizador + invitado (user_id, email o teléfono del perfil). Email y teléfono salen de la
 * sesión y del perfil en el servidor. Enlaza user_id en el invitado cuando coincidió por contacto (backfill).
 */
export async function listMyReservationsAction(): Promise<{ organizer: any[]; guest: any[]; error?: string }> {
    const user = await currentUser();
    if (!user) return { organizer: [], guest: [], error: "unauthenticated" };
    if (!rateLimit(`tk-list:${user.id}`, 30, 60_000).allowed) return { organizer: [], guest: [], error: "rate_limited" };

    const db = admin();
    const { data: profile } = await db.from("profiles").select("email, phone_number, phone").eq("id", user.id).maybeSingle();
    const email: string | null = user.email ?? profile?.email ?? null;
    const phone: string | null = profile?.phone_number ?? profile?.phone ?? null;
    const who = { userId: user.id, email, phone };

    const orgQuery = db.from("reservations").select(RESERVATION_SELECT).eq("organizer_id", user.id)
        .order("date_time", { ascending: false }).limit(150);

    const candidates: Record<string, string>[] = [{ user_id: user.id }];
    if (email) for (const e of Array.from(new Set([email, email.toLowerCase()]))) candidates.push({ email: e });
    if (phone) candidates.push({ phone });
    const guestQueries = ["guest_data", "guests"].flatMap((col) =>
        candidates.map((c) =>
            db.from("reservations").select(RESERVATION_SELECT).neq("organizer_id", user.id)
                .filter(col, "cs", JSON.stringify([c])).order("date_time", { ascending: false }).limit(50),
        ),
    );

    const [orgRes, ...guestResults] = await Promise.all([orgQuery, ...guestQueries]);
    if (orgRes.error) return { organizer: [], guest: [], error: "fetch_failed" };

    const seen = new Set<string>();
    const guest: any[] = [];
    for (const r of guestResults) {
        if (r.error) continue;
        for (const row of r.data || []) {
            if (seen.has(row.id)) continue;
            // Verificación en código, además del filtro SQL.
            if (!ticketGuests(row).some((g: any) => guestMatchesContact(g, who))) continue;
            seen.add(row.id);
            guest.push(row);
        }
    }
    const byDate = (a: any, b: any) => new Date(b.date_time).getTime() - new Date(a.date_time).getTime();
    guest.sort(byDate);

    // Backfill de user_id: solo por email verificado de la cuenta. El teléfono del perfil no se usa para
    // escribir, porque no está verificado y quedaría como relación permanente (token de visor).
    if (user.email && user.email_confirmed_at) {
        const mine = user.email.toLowerCase();
        for (const row of guest) {
            const patch: Record<string, any> = {};
            for (const col of ["guest_data", "guests"] as const) {
                const arr = row[col];
                if (!Array.isArray(arr)) continue;
                let changed = false;
                const next = arr.map((g: any) => {
                    if (g && typeof g === "object" && !g.user_id && typeof g.email === "string" && g.email.toLowerCase() === mine) {
                        changed = true;
                        return { ...g, user_id: user.id };
                    }
                    return g;
                });
                if (changed) patch[col] = next;
            }
            if (Object.keys(patch).length) {
                const { error } = await db.from("reservations").update(patch).eq("id", row.id);
                if (error) console.warn("[my-tickets] backfill guest user_id falló (no fatal):", error.message);
            }
        }
    }

    return { organizer: orgRes.data || [], guest };
}
