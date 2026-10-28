"use server";

import { createClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/utils/supabase/server";

let _supabaseAdmin: ReturnType<typeof createClient> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
    }
    return _supabaseAdmin;
}

// Ventana en la que se acepta avisar de un registro recién creado (evita re-disparos tardíos).
const MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Aviso persistente al staff del restaurante por una reserva / pedido takeaway nuevo.
 *
 * Reemplaza a la RPC notify_restaurant_admins, que nunca funcionó (columnas inexistentes) y
 * permitía a anon/authenticated insertar notificaciones saltándose RLS. Aquí:
 *  - se exige sesión y que el registro pertenezca al usuario logueado;
 *  - restaurante y texto se derivan de la BD, nunca del cliente;
 *  - el formato es el mismo que usa transition_status (type RESERVATION/TAKEAWAY, related_id, priority);
 *  - es idempotente por (related_id, type): un segundo llamado no duplica.
 */
export async function notifyRestaurantNewBookingAction(input: {
    type: "reservation" | "order";
    resourceId: string;
}): Promise<{ success: boolean; notified?: number; error?: string }> {
    try {
        const session = await createSessionClient();
        const { data: { user }, error: authError } = await session.auth.getUser();
        if (authError || !user) return { success: false, error: "No autenticado" };

        const isReservation = input.type === "reservation";
        if (!isReservation && input.type !== "order") return { success: false, error: "Tipo inválido" };

        const admin = supabaseAdmin();
        const table = isReservation ? "reservations" : "takeaway_orders";
        const ownerCol = isReservation ? "organizer_id" : "user_id";

        const { data: record, error: recError } = await (admin as any)
            .from(table)
            .select(`id, restaurant_id, created_at, ${ownerCol}`)
            .eq("id", input.resourceId)
            .maybeSingle();
        if (recError || !record) return { success: false, error: "Registro no encontrado" };
        if (record[ownerCol] !== user.id) return { success: false, error: "Sin permiso" };
        if (Date.now() - new Date(record.created_at).getTime() > MAX_AGE_MS) {
            return { success: false, error: "Registro demasiado antiguo" };
        }

        const notifType = isReservation ? "RESERVATION" : "TAKEAWAY";

        const { count: already } = await (admin as any)
            .from("notifications")
            .select("id", { count: "exact", head: true })
            .eq("related_id", record.id)
            .eq("type", notifType)
            .eq("restaurant_id", record.restaurant_id)
            .eq("actor_role", "customer");
        if (already && already > 0) return { success: true, notified: 0 };

        const [{ data: restaurant }, { data: staff, error: staffError }] = await Promise.all([
            (admin as any).from("restaurants").select("name").eq("id", record.restaurant_id).maybeSingle(),
            (admin as any).from("profiles").select("id").eq("restaurant_id", record.restaurant_id),
        ]);
        if (staffError) return { success: false, error: staffError.message };
        if (!staff || staff.length === 0) return { success: true, notified: 0 };

        const rows = staff.map((p: { id: string }) => ({
            user_id: p.id,
            restaurant_id: record.restaurant_id,
            type: notifType,
            title: restaurant?.name ?? "Restaurante",
            message: isReservation ? "Nueva reserva recibida" : "Nuevo pedido takeaway recibido",
            related_id: record.id,
            priority: "CRITICAL",
            actor_id: user.id,
            actor_role: "customer",
        }));

        const { error: insError } = await (admin as any).from("notifications").insert(rows);
        if (insError) return { success: false, error: insError.message };

        return { success: true, notified: rows.length };
    } catch (err: any) {
        console.error("[notifyRestaurantNewBooking]", err);
        return { success: false, error: err?.message ?? "Error" };
    }
}
