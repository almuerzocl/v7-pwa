import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { isRelatedToTicket, signViewerToken, TOKEN_TTL_S } from "@/lib/ticket-viewer-token";

const SECRET = "s".repeat(40);
const ORG = "11111111-1111-4111-8111-111111111111";
const GUEST = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

const reservation = {
    organizer_id: ORG, user_id: null,
    guest_data: [{ id: "g1", is_organizer: true }, { id: "g2", user_id: GUEST }, { id: "g3" }],
};

describe("isRelatedToTicket", () => {
    it("organizador de la reserva", () => expect(isRelatedToTicket("r", reservation, ORG)).toBe(true));
    it("invitado registrado", () => expect(isRelatedToTicket("r", reservation, GUEST)).toBe(true));
    it("cliente del pedido", () => expect(isRelatedToTicket("o", { user_id: CLIENT }, CLIENT)).toBe(true));
    it("usuario logueado sin relación", () => {
        expect(isRelatedToTicket("r", reservation, OTHER)).toBe(false);
        expect(isRelatedToTicket("o", { user_id: CLIENT }, OTHER)).toBe(false);
    });
    it("no confunde reserva con pedido ni acepta uid vacío o fila inexistente", () => {
        expect(isRelatedToTicket("o", reservation, ORG)).toBe(false);
        expect(isRelatedToTicket("r", reservation, "")).toBe(false);
        expect(isRelatedToTicket("r", null, ORG)).toBe(false);
        expect(isRelatedToTicket("r", { organizer_id: null, user_id: null, guest_data: "x" }, OTHER)).toBe(false);
    });
});

describe("signViewerToken", () => {
    it("contrato: v1.<payload>.<HMAC>, 60 s, jti único", () => {
        const now = 1_800_000_000_000;
        const t1 = signViewerToken({ sub: ORG, code: "ABCD1234", kind: "r" }, SECRET, now);
        const t2 = signViewerToken({ sub: ORG, code: "ABCD1234", kind: "r" }, SECRET, now);
        const [v, body, sig] = t1.split(".");
        expect(v).toBe("v1");
        expect(sig).toBe(createHmac("sha256", SECRET).update(`v1.${body}`).digest("base64url"));
        const p = JSON.parse(Buffer.from(body, "base64url").toString());
        expect(p).toMatchObject({ v: 1, iss: "almuerzo-pwa", aud: "almuerzo-tickets", sub: ORG, code: "ABCD1234", kind: "r", iat: now / 1000, exp: now / 1000 + TOKEN_TTL_S });
        expect(p.jti).not.toBe(JSON.parse(Buffer.from(t2.split(".")[1], "base64url").toString()).jti);
        expect(t1).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });
    it("se niega a firmar con secreto ausente o corto", () => {
        expect(() => signViewerToken({ sub: ORG, code: "ABCD1234", kind: "r" }, "")).toThrow();
        expect(() => signViewerToken({ sub: ORG, code: "ABCD1234", kind: "r" }, "corto")).toThrow();
    });
});
