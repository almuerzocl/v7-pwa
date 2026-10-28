// Token de visor ("relacionado con el ticket"). SOLO SERVIDOR.
//
// La PWA decide la relación en su servidor y firma un token de 60 s, de un solo uso (jti), ligado a un
// usuario, a un código y a un tipo. public-tickets lo valida (firma, vencimiento, código, tipo, jti) y NO
// consulta la relación. Contrato idéntico al de public-tickets/src/lib/server/viewer-token.ts:
//   formato   v1.<payload JSON en base64url>.<HMAC-SHA256 del texto "v1.<payload>" en base64url>
//   payload   { v:1, iss:'almuerzo-pwa', aud:'almuerzo-tickets', sub:<uid>, code, kind:'r'|'o', iat, exp, jti:<uuid> }
//   secreto   TICKET_VIEWER_SECRET (Secret Manager `ticket-viewer-signing-secret`, el mismo en ambos servicios)
// El token viaja al iframe por el fragmento de la URL (#vt=...), nunca por query string.
import { createHmac, randomUUID } from "node:crypto";

export type TicketViewerKind = "r" | "o";
export const TOKEN_TTL_S = 60;

export function signViewerToken(
    input: { sub: string; code: string; kind: TicketViewerKind },
    secret: string,
    nowMs: number = Date.now(),
): string {
    if (!secret || secret.length < 32) throw new Error("TICKET_VIEWER_SECRET ausente o demasiado corto");
    const iat = Math.floor(nowMs / 1000);
    const payload = {
        v: 1, iss: "almuerzo-pwa", aud: "almuerzo-tickets",
        sub: input.sub, code: input.code, kind: input.kind, iat, exp: iat + TOKEN_TTL_S, jti: randomUUID(),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(`v1.${body}`).digest("base64url");
    return `v1.${body}.${sig}`;
}

/**
 * Invitados de una reserva. Fuente de verdad: `guest_data` (la escribe la PWA al crear). `guests` es una columna
 * heredada que aún lee "Mis reservas": se usa solo de respaldo cuando `guest_data` no trae un arreglo con datos.
 */
export function ticketGuests(row: Record<string, any> | null | undefined): any[] {
    if (Array.isArray(row?.guest_data) && row!.guest_data.length > 0) return row!.guest_data;
    return Array.isArray(row?.guests) ? row!.guests : [];
}

/** ¿El invitado coincide con la identidad del usuario por user_id, email o teléfono? (Mis reservas) */
export function guestMatchesContact(
    g: any,
    who: { userId: string; email?: string | null; phone?: string | null },
): boolean {
    if (!g || typeof g !== "object") return false;
    if (g.user_id === who.userId) return true;
    if (who.email && typeof g.email === "string" && g.email.toLowerCase() === who.email.toLowerCase()) return true;
    return !!who.phone && g.phone === who.phone;
}

/**
 * ¿El usuario está relacionado con el ticket? Decidido en código sobre el registro leído con service_role
 * (NO con RLS bajo la sesión). Relacionado = organizador o titular de la reserva, invitado registrado
 * (guest_data[*].user_id, con `guests` de respaldo) o cliente del pedido.
 * Es la regla única: la usan el token de visor, las lecturas de /reservations/[id], /orders/[id] y "Mis reservas".
 * DEPENDENCIA: si cambian las columnas que identifican organizador/cliente/invitado, hay que ajustar esto.
 */
export function isRelatedToTicket(kind: TicketViewerKind, row: Record<string, any> | null | undefined, uid: string): boolean {
    if (!row || !uid) return false;
    if (kind === "o") return row.user_id === uid;
    if (row.organizer_id === uid || row.user_id === uid) return true;
    return ticketGuests(row).some((g: any) => g && typeof g === "object" && g.user_id === uid);
}
