"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Ticket, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";

type Active = { href: string; title: string; detail: string };

// Acceso directo al ticket vigente (reserva próxima o pedido en curso) para mostrarlo en el local sin buscarlo.
// Solo lee lo del propio usuario; si falla o no hay nada, no se muestra.
export function ActiveTicketCard() {
    const { user } = useAuth();
    const [active, setActive] = useState<Active | null>(null);

    useEffect(() => {
        if (!user?.id) return;
        let cancelled = false;
        (async () => {
            try {
                const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
                const [res, ord] = await Promise.all([
                    supabase.from("reservations").select("id, date_time, status, restaurant:restaurants(name)")
                        .eq("organizer_id", user.id).in("status", ["CONFIRMADA", "CHECK-IN CLIENTE"])
                        .gte("date_time", since).order("date_time", { ascending: true }).limit(1),
                    supabase.from("takeaway_orders").select("id, status, restaurant:restaurants(name)")
                        .eq("user_id", user.id).in("status", ["APROBADA", "PREPARANDO", "LISTO"])
                        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
                        .order("created_at", { ascending: false }).limit(1),
                ]);
                if (cancelled) return;
                const r: any = res.data?.[0];
                const o: any = ord.data?.[0];
                if (o && (o.status === "LISTO" || !r)) {
                    setActive({ href: `/orders/${o.id}`, title: "Tu pedido", detail: `${o.restaurant?.name ?? "Restaurante"} · ${o.status === "LISTO" ? "listo para retirar" : "en preparación"}` });
                } else if (r) {
                    setActive({ href: `/reservations/${r.id}`, title: "Tu próxima reserva", detail: `${r.restaurant?.name ?? "Restaurante"} · ${format(new Date(r.date_time), "EEEE d 'a las' HH:mm", { locale: es })}` });
                }
            } catch {
                /* sin tarjeta */
            }
        })();
        return () => { cancelled = true; };
    }, [user?.id]);

    if (!active) return null;

    return (
        <Link href={active.href} className="flex items-center gap-3 rounded-2xl border border-orange-200 bg-orange-50 p-4 min-h-14 active:scale-[0.99] transition-transform">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-500 text-white"><Ticket className="h-5 w-5" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1">
                <span className="block text-xs font-black uppercase tracking-wider text-zinc-700">{active.title}</span>
                <span className="block truncate text-sm font-bold text-zinc-900">{active.detail}</span>
            </span>
            <span className="text-xs font-bold text-orange-700">Ver ticket</span>
            <ChevronRight className="h-4 w-4 text-orange-700" aria-hidden="true" />
        </Link>
    );
}
