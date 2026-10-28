import { beforeEach, describe, expect, it } from "vitest";
import { processOrderConfirmations } from "@/lib/server/order-confirmation";
import { MAX_NOTIFY_ATTEMPTS, type ConfirmationDeps } from "@/lib/server/reservation-confirmation";

// Base en memoria que imita claim_order_confirmations (migración 034; la SQL real se probó aparte contra la base).
type Row = Record<string, any>;
const NOW = new Date("2026-10-10T15:00:00Z");
const RECENT = "2026-10-10T14:30:00Z";
const OLD = "2026-10-09T10:00:00Z";

function makeDb(rows: Row[], profiles: Row[] = [{ id: "u1", email: "cli@x.cl", first_name: "Carla" }]) {
    const logs: Row[] = [];
    const table = (name: string) => {
        const data = name === "takeaway_orders" ? rows : name === "profiles" ? profiles
            : name === "restaurants" ? [{ id: "rest1", name: "Cri-Olla" }] : logs;
        let filter: [string, any] | null = null;
        const b: any = {
            select: () => b,
            eq: (c: string, v: any) => { filter = [c, v]; return b; },
            maybeSingle: async () => ({ data: data.find((r) => !filter || r[filter[0]] === filter[1]) ?? null, error: null }),
            insert: async (o: Row) => { logs.push(o); return { error: null }; },
            update: (patch: Row) => ({ eq: async (c: string, v: any) => { data.filter((r) => r[c] === v).forEach((r) => Object.assign(r, patch)); return { error: null }; } }),
        };
        return b;
    };
    const admin: any = {
        from: table,
        rpc: async (_fn: string, { p_limit, p_id }: { p_limit: number; p_id: string | null }) => {
            const el = rows.filter((r) =>
                ["APROBADA", "PREPARANDO"].includes(r.status) && !r.confirmation_notified_at &&
                new Date(r.created_at).getTime() > NOW.getTime() - 12 * 3600_000 &&
                r.confirmation_notify_attempts < MAX_NOTIFY_ATTEMPTS && !r.confirmation_notify_claimed_at && (!p_id || r.id === p_id)).slice(0, p_limit);
            el.forEach((r) => { r.confirmation_notify_claimed_at = NOW.toISOString(); r.confirmation_notify_attempts++; });
            return { data: el.map((r) => ({ ...r })), error: null };
        },
    };
    return { admin, logs };
}

const order = (o: Row = {}): Row => ({
    id: "22222222-2222-4222-8222-222222222222", unique_code: "ORD12345", user_id: "u1", restaurant_id: "rest1",
    status: "APROBADA", created_at: RECENT, total_amount: 7500, customer_name: "Carla Soto",
    items: [{ name: "Menú", quantity: 2 }, { name: "Postre", quantity: 1 }], metadata: { pickup_time: "13:30" },
    confirmation_notified_at: null, confirmation_notify_attempts: 0, confirmation_notify_claimed_at: null, ...o,
});

let sent: Row[];
let failFor: Set<string>;
const mkDeps = (db: ReturnType<typeof makeDb>): ConfirmationDeps => ({
    admin: db.admin, now: () => NOW,
    send: async (p) => { if (failFor.has(p.to)) return { success: false, error: "Resend caído" }; sent.push(p); return { success: true }; },
});
beforeEach(() => { sent = []; failFor = new Set(); });

describe("correo 'Pedido confirmado' solo con el pedido APROBADA", () => {
    it("PENDIENTE no envía nada", async () => {
        const r = await processOrderConfirmations({}, mkDeps(makeDb([order({ status: "PENDIENTE" })])));
        expect(r.claimed).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it("APROBADA envía una vez al cliente con unidades, total y retiro; no se repite", async () => {
        const rows = [order()];
        const db = makeDb(rows);
        const r = await processOrderConfirmations({}, mkDeps(db));
        expect(r).toMatchObject({ claimed: 1, completed: 1, emailsSent: 1 });
        expect(sent[0].to).toBe("cli@x.cl");
        expect(sent[0].subject).toBe("Pedido confirmado en Cri-Olla");
        expect(sent[0].html).toContain("13:30");
        expect(sent[0].html).toContain("/o/ORD12345");
        expect(sent[0].html).toContain("Tu pedido está confirmado");
        expect(rows[0].confirmation_notified_at).toBeTruthy();
        const again = await processOrderConfirmations({}, mkDeps(db));
        expect(again.claimed).toBe(0);
        expect(sent).toHaveLength(1);
    });

    it("pedido tomado por el restaurante: usa el correo del cliente en metadata", async () => {
        const db = makeDb([order({ metadata: { is_manual: true, customer_email: "manual@x.cl", pickup_time: "14:00" } })]);
        await processOrderConfirmations({}, mkDeps(db));
        expect(sent.map((s) => s.to)).toEqual(["manual@x.cl"]);
    });

    it("dos ejecuciones simultáneas envían una sola vez", async () => {
        const db = makeDb([order()]);
        await Promise.all([processOrderConfirmations({}, mkDeps(db)), processOrderConfirmations({}, mkDeps(db))]);
        expect(sent).toHaveLength(1);
    });

    it("falla de envío: libera el reclamo, reintenta y respeta el tope; deja el error en error_logs", async () => {
        const rows = [order()];
        const db = makeDb(rows);
        failFor.add("cli@x.cl");
        for (let i = 0; i < MAX_NOTIFY_ATTEMPTS + 2; i++) await processOrderConfirmations({}, mkDeps(db));
        expect(rows[0].confirmation_notify_attempts).toBe(MAX_NOTIFY_ATTEMPTS);
        expect(db.logs.some((l) => l.source === "order-confirmation" && l.message.includes("SE ABANDONA"))).toBe(true);
        expect(rows[0].confirmation_notified_at).toBeNull();
    });

    it("un pedido antiguo (más de 12 h) no envía", async () => {
        const r = await processOrderConfirmations({}, mkDeps(makeDb([order({ created_at: OLD })])));
        expect(r.claimed).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it("RECHAZADA, CANCELADO o ya ENTREGADO no envían", async () => {
        for (const status of ["RECHAZADA", "CANCELADO", "ENTREGADO", "NO_RETIRADO"]) {
            await processOrderConfirmations({}, mkDeps(makeDb([order({ status })])));
        }
        expect(sent).toHaveLength(0);
    });

    it("si cambió de estado entre el reclamo y el envío, no envía y libera el reclamo", async () => {
        const rows = [order()];
        const db = makeDb(rows);
        const orig = db.admin.rpc;
        db.admin.rpc = async (...a: any[]) => { const res = await orig(...a); rows[0].status = "CANCELADO"; return res; };
        const r = await processOrderConfirmations({}, mkDeps(db));
        expect(r.skipped).toBe(1);
        expect(sent).toHaveLength(0);
        expect(rows[0].confirmation_notify_claimed_at).toBeNull();
    });

    it("sin correo del cliente: no envía y cierra para no reintentar", async () => {
        const rows = [order({ user_id: "otro" })];
        const r = await processOrderConfirmations({}, mkDeps(makeDb(rows, [])));
        expect(r.skipped).toBe(1);
        expect(sent).toHaveLength(0);
        expect(rows[0].confirmation_notified_at).toBeTruthy();
    });

    it("items como texto JSON: cuenta las unidades", async () => {
        const db = makeDb([order({ items: JSON.stringify([{ quantity: 3 }, { quantity: 2 }]) })]);
        await processOrderConfirmations({}, mkDeps(db));
        expect(sent[0].html).toContain("$7.500");
    });

    it("con opciones, el correo lista cada plato con lo elegido (escapado) y el texto plano también", async () => {
        const items = [{ name: "Pastel <b>", quantity: 2, price: 8500, options: [{ name: "Papas fritas", price_delta: 0 }, { name: "Queso & palta", price_delta: 800 }] }, { name: "Bebida", quantity: 1 }];
        await processOrderConfirmations({}, mkDeps(makeDb([order({ items })])));
        expect(sent[0].html).toContain("Tu pedido</td>");
        expect(sent[0].html).toContain("2&times; Pastel &lt;b&gt;");
        expect(sent[0].html).toContain("Papas fritas, Queso &amp; palta");
        expect(sent[0].html).not.toContain("<b>");
        expect(sent[0].text).toContain("Detalle: 2x Pastel <b> (Papas fritas, Queso & palta); 1x Bebida.");
    });

    it("sin opciones, el correo no cambia (no agrega el detalle)", async () => {
        await processOrderConfirmations({}, mkDeps(makeDb([order()])));
        expect(sent[0].html).not.toContain("Tu pedido</td>");
        expect(sent[0].text).not.toContain("Detalle:");
    });
});
