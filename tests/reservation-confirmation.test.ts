import { beforeEach, describe, expect, it } from "vitest";
import { processReservationConfirmations, processReservationRejections, MAX_NOTIFY_ATTEMPTS, type ConfirmationDeps } from "@/lib/server/reservation-confirmation";

// Base en memoria que imita el contrato de claim_reservation_confirmations (migración 031; la SQL real se probó
// aparte contra la base) y las consultas que hace el emisor.
type Row = Record<string, any>;
const NOW = new Date("2026-10-10T15:00:00Z");
const FUTURE = "2026-10-12T16:00:00Z";
const PAST = "2026-10-09T16:00:00Z";

function makeDb(rows: Row[], profiles: Row[] = []) {
    const logs: Row[] = [];
    const table = (name: string) => {
        const data = name === "reservations" ? rows : name === "profiles" ? profiles
            : name === "restaurants" ? [{ id: "rest1", name: "Cri-Olla", address: "Av. 1" }] : logs;
        let filter: [string, any] | null = null;
        const b: any = {
            select: (cols?: string) => {
                // Columnas que NO existen en la base real: pedirlas rompería la consulta (lección del 2026-10-06).
                if (cols && /\b(owner_id|avg_prep_time)\b/.test(cols)) throw new Error('column does not exist');
                return b;
            },
            eq: (c: string, v: any) => { filter = [c, v]; return b; },
            maybeSingle: async () => ({ data: data.find((r) => !filter || r[filter[0]] === filter[1]) ?? null, error: null }),
            insert: async (o: Row) => { logs.push(o); return { error: null }; },
            update: (patch: Row) => ({
                eq: async (c: string, v: any) => {
                    data.filter((r) => r[c] === v).forEach((r) => Object.assign(r, patch));
                    return { error: null };
                },
            }),
        };
        return b;
    };
    const admin: any = {
        from: table,
        rpc: async (fn: string, { p_limit, p_id }: { p_limit: number; p_id: string | null }) => {
            if (fn === 'claim_reservation_rejections') {
                const el = rows.filter((r) =>
                    r.status === 'RECHAZADA' && !r.rejection_notified_at && new Date(r.date_time) > NOW &&
                    (r.rejection_notify_attempts ?? 0) < MAX_NOTIFY_ATTEMPTS && !r.rejection_notify_claimed_at &&
                    (!p_id || r.id === p_id)).slice(0, p_limit);
                el.forEach((r) => { r.rejection_notify_claimed_at = NOW.toISOString(); r.rejection_notify_attempts = (r.rejection_notify_attempts ?? 0) + 1; });
                return { data: el.map((r) => ({ ...r })), error: null };
            }
            const eligible = rows.filter((r) =>
                r.status === "CONFIRMADA" && !r.confirmation_notified_at && new Date(r.date_time) > NOW &&
                r.confirmation_notify_attempts < MAX_NOTIFY_ATTEMPTS && !r.confirmation_notify_claimed_at &&
                (!p_id || r.id === p_id)).slice(0, p_limit);
            eligible.forEach((r) => { r.confirmation_notify_claimed_at = NOW.toISOString(); r.confirmation_notify_attempts++; });
            return { data: eligible.map((r) => ({ ...r })), error: null };
        },
    };
    return { admin, logs };
}

const base = (o: Row = {}): Row => ({
    id: "11111111-1111-4111-8111-111111111111", unique_code: "ABC12345", restaurant_id: "rest1", organizer_id: "u1",
    status: "CONFIRMADA", date_time: FUTURE, party_size: 3, confirmation_notified_at: null,
    confirmation_notify_attempts: 0, confirmation_notify_claimed_at: null, confirmation_sent: {},
    guest_data: [
        { id: "o1", name: "Ana Pérez", email: "ana@x.cl", is_organizer: true, status: "CONFIRMADA" },
        { id: "g1", name: "Beto", email: "beto@x.cl", is_organizer: false, status: "PENDIENTE" },
        { id: "g2", name: "Sin Correo", email: null, is_organizer: false, status: "PENDIENTE" },
    ], ...o,
});

let sent: Row[];
let failFor: Set<string>;
const mkDeps = (db: ReturnType<typeof makeDb>): ConfirmationDeps => ({
    admin: db.admin, now: () => NOW,
    send: async (p) => {
        if (failFor.has(p.to)) return { success: false, error: "Resend caído" };
        sent.push(p);
        return { success: true };
    },
});
beforeEach(() => { sent = []; failFor = new Set(); });

describe("emisor de confirmaciones de reserva", () => {
    it("PENDIENTE no envía nada", async () => {
        const db = makeDb([base({ status: "PENDIENTE" })]);
        const r = await processReservationConfirmations({}, mkDeps(db));
        expect(r.claimed).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it("CONFIRMADA envía una confirmación al organizador y una invitación por invitado con correo, una sola vez", async () => {
        const rows = [base()];
        const db = makeDb(rows);
        const r = await processReservationConfirmations({}, mkDeps(db));
        expect(r).toMatchObject({ claimed: 1, completed: 1, emailsSent: 2 });
        expect(sent.map((s) => s.to).sort()).toEqual(["ana@x.cl", "beto@x.cl"]);
        const conf = sent.find((s) => s.to === "ana@x.cl")!;
        expect(conf.subject).toBe("Reserva confirmada en Cri-Olla");
        expect(conf.html).not.toContain("PENDIENTE>");
        expect(conf.html).toContain("Tu reserva está confirmada");
        expect(conf.html).toContain("CONFIRMADA");
        const inv = sent.find((s) => s.to === "beto@x.cl")!;
        expect(inv.subject).toBe("Has sido invitado a almorzar con Ana Pérez en Cri-Olla");
        expect(inv.html).toContain("/v/ABC12345?g=g1&a=confirm");
        expect(rows[0].confirmation_notified_at).toBeTruthy();
        // segunda ejecución: nada
        const again = await processReservationConfirmations({}, mkDeps(db));
        expect(again.claimed).toBe(0);
        expect(sent).toHaveLength(2);
    });

    it("el correo ya no muestra la etiqueta PENDIENTE (reserva solo con organizador)", async () => {
        const db = makeDb([base({ guest_data: [{ id: "o1", name: "Ana", email: "ana@x.cl", is_organizer: true, status: "CONFIRMADA" }] })]);
        await processReservationConfirmations({}, mkDeps(db));
        expect(sent[0].html).not.toContain("PENDIENTE");
        expect(sent[0].html).toContain("CONFIRMADA");
    });

    it("dos ejecuciones simultáneas envían una sola vez", async () => {
        const db = makeDb([base()]);
        const [a, b] = await Promise.all([
            processReservationConfirmations({}, mkDeps(db)),
            processReservationConfirmations({}, mkDeps(db)),
        ]);
        expect(a.claimed + b.claimed).toBe(1);
        expect(sent).toHaveLength(2);
    });

    it("falla de envío: libera el reclamo, reintenta solo lo que faltó y respeta el tope", async () => {
        const rows = [base()];
        const db = makeDb(rows);
        failFor.add("beto@x.cl");
        const r1 = await processReservationConfirmations({}, mkDeps(db));
        expect(r1).toMatchObject({ failed: 1, emailsSent: 1 });
        expect(rows[0].confirmation_notified_at).toBeNull();
        expect(rows[0].confirmation_sent).toEqual({ organizer: true });
        expect(db.logs.at(-1)!.severity).toBe("error");
        // reintento: el organizador NO se repite
        failFor.clear();
        const r2 = await processReservationConfirmations({}, mkDeps(db));
        expect(r2.completed).toBe(1);
        expect(sent.filter((s) => s.to === "ana@x.cl")).toHaveLength(1);
        expect(sent.filter((s) => s.to === "beto@x.cl")).toHaveLength(1);
    });

    it("tras el tope de intentos deja de reintentar y lo registra", async () => {
        const rows = [base()];
        const db = makeDb(rows);
        failFor.add("beto@x.cl");
        for (let i = 0; i < MAX_NOTIFY_ATTEMPTS + 2; i++) await processReservationConfirmations({}, mkDeps(db));
        expect(rows[0].confirmation_notify_attempts).toBe(MAX_NOTIFY_ATTEMPTS);
        expect(db.logs.some((l) => l.message.includes("SE ABANDONA"))).toBe(true);
        expect(rows[0].confirmation_notified_at).toBeNull();
    });

    it("una reserva cuya hora ya pasó no envía", async () => {
        const db = makeDb([base({ date_time: PAST })]);
        const r = await processReservationConfirmations({}, mkDeps(db));
        expect(r.claimed).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it("rechazada o cancelada no envía", async () => {
        for (const status of ["RECHAZADA", "CANCELADA"]) {
            const db = makeDb([base({ status })]);
            await processReservationConfirmations({}, mkDeps(db));
        }
        expect(sent).toHaveLength(0);
    });

    it("si cambió de estado entre el reclamo y el envío, no envía y libera el reclamo", async () => {
        const rows = [base()];
        const db = makeDb(rows);
        const orig = db.admin.rpc;
        db.admin.rpc = async (...a: any[]) => { const res = await orig(...a); rows[0].status = "CANCELADA"; return res; };
        const r = await processReservationConfirmations({}, mkDeps(db));
        expect(r.skipped).toBe(1);
        expect(sent).toHaveLength(0);
        expect(rows[0].confirmation_notify_claimed_at).toBeNull();
    });

    it("sin invitados con correo solo envía la confirmación", async () => {
        const db = makeDb([base({ guest_data: [{ id: "o1", name: "Ana", email: "ana@x.cl", is_organizer: true }, { id: "g2", name: "X", email: null }] })]);
        const r = await processReservationConfirmations({}, mkDeps(db));
        expect(r.emailsSent).toBe(1);
        expect(sent[0].to).toBe("ana@x.cl");
    });

    it("invitado con el mismo correo del organizador no recibe invitación aparte", async () => {
        const db = makeDb([base({ guest_data: [{ id: "o1", name: "Ana", email: "ANA@x.cl", is_organizer: true }, { id: "g1", name: "Ana2", email: "ana@x.cl" }] })]);
        await processReservationConfirmations({}, mkDeps(db));
        expect(sent).toHaveLength(1);
    });

    it("reserva manual del restaurante: envía al cliente del guest_data (sin organizador en guest_data)", async () => {
        const db = makeDb([base({
            guest_data: [{ name: "Carla Soto", phone: "+5691", email: "carla@x.cl", is_manual: true }],
        })]);
        const r = await processReservationConfirmations({}, mkDeps(db));
        expect(r.emailsSent).toBe(1);
        expect(sent[0].to).toBe("carla@x.cl");
        expect(sent[0].subject).toBe("Reserva confirmada en Cri-Olla");
    });

    it("sin correo en guest_data usa el del perfil del organizador", async () => {
        const db = makeDb(
            [base({ guest_data: [{ id: "o1", name: "Ana", email: null, is_organizer: true }] })],
            [{ id: "u1", email: "perfil@x.cl", first_name: "Ana", last_name: "P" }],
        );
        await processReservationConfirmations({}, mkDeps(db));
        expect(sent.map((s) => s.to)).toEqual(["perfil@x.cl"]);
    });

    it("escapa HTML en nombres de invitados", async () => {
        const db = makeDb([base({ guest_data: [{ id: "o1", name: "<script>x</script>", email: "ana@x.cl", is_organizer: true }] })]);
        await processReservationConfirmations({}, mkDeps(db));
        expect(sent[0].html).not.toContain("<script>x</script>");
        expect(sent[0].html).toContain("&lt;script&gt;");
    });
});

describe("aviso de rechazo: solo al organizador", () => {
    const rejected = (o: Row = {}) => base({ status: "RECHAZADA", cancellation_reason: "Sin mesas ese día", ...o });

    it("RECHAZADA envía UN correo, solo al organizador (no a los invitados), una sola vez", async () => {
        const rows = [rejected()];
        const db = makeDb(rows);
        const r = await processReservationRejections({}, mkDeps(db));
        expect(r).toMatchObject({ claimed: 1, completed: 1, emailsSent: 1 });
        expect(sent).toHaveLength(1);
        expect(sent[0].to).toBe("ana@x.cl");
        expect(sent[0].subject).toBe("Tu reserva en Cri-Olla no pudo ser confirmada");
        expect(sent[0].html).toContain("no pudo ser confirmada");
        expect(sent[0].html).toContain("Sin mesas ese día");
        expect(sent[0].html).not.toContain("beto@x.cl");
        expect(rows[0].rejection_notified_at).toBeTruthy();
        const again = await processReservationRejections({}, mkDeps(db));
        expect(again.claimed).toBe(0);
        expect(sent).toHaveLength(1);
    });

    it("el motivo se escapa en el HTML y es opcional", async () => {
        const db = makeDb([rejected({ cancellation_reason: "<b>x</b>" })]);
        await processReservationRejections({}, mkDeps(db));
        expect(sent[0].html).not.toContain("<b>x</b>");
        const db2 = makeDb([rejected({ cancellation_reason: null })]);
        sent = [];
        await processReservationRejections({}, mkDeps(db2));
        expect(sent[0].html).not.toContain("Motivo:");
    });

    it("PENDIENTE no envía ningún aviso de rechazo", async () => {
        const db = makeDb([base({ status: "PENDIENTE" })]);
        const r = await processReservationRejections({}, mkDeps(db));
        expect(r.claimed).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it("CANCELADA y CONFIRMADA no disparan aviso de rechazo", async () => {
        for (const status of ["CANCELADA", "CONFIRMADA"]) {
            await processReservationRejections({}, mkDeps(makeDb([base({ status })])));
        }
        expect(sent).toHaveLength(0);
    });

    it("rechazada con hora ya pasada no envía", async () => {
        const r = await processReservationRejections({}, mkDeps(makeDb([rejected({ date_time: PAST })])));
        expect(r.claimed).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it("dos ejecuciones simultáneas envían una sola vez", async () => {
        const db = makeDb([rejected()]);
        await Promise.all([processReservationRejections({}, mkDeps(db)), processReservationRejections({}, mkDeps(db))]);
        expect(sent).toHaveLength(1);
    });

    it("falla de envío: libera el reclamo, reintenta y respeta el tope", async () => {
        const rows = [rejected()];
        const db = makeDb(rows);
        failFor.add("ana@x.cl");
        for (let i = 0; i < MAX_NOTIFY_ATTEMPTS + 2; i++) await processReservationRejections({}, mkDeps(db));
        expect(rows[0].rejection_notify_attempts).toBe(MAX_NOTIFY_ATTEMPTS);
        expect(rows[0].rejection_notified_at).toBeUndefined();
        expect(db.logs.some((l) => l.message.includes("SE ABANDONA"))).toBe(true);
    });

    it("reserva manual rechazada: avisa al cliente del guest_data", async () => {
        const db = makeDb([rejected({ guest_data: [{ name: "Carla", email: "carla@x.cl", is_manual: true }] })]);
        await processReservationRejections({}, mkDeps(db));
        expect(sent.map((s) => s.to)).toEqual(["carla@x.cl"]);
    });

    it("si cambió de estado entre el reclamo y el envío, no envía", async () => {
        const rows = [rejected()];
        const db = makeDb(rows);
        const orig = db.admin.rpc;
        db.admin.rpc = async (...a: any[]) => { const res = await orig(...a); rows[0].status = "CONFIRMADA"; return res; };
        const r = await processReservationRejections({}, mkDeps(db));
        expect(r.skipped).toBe(1);
        expect(sent).toHaveLength(0);
    });
});
