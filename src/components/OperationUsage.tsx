"use client";

import { useEffect, useState } from "react";
import { Crown, Gauge } from "lucide-react";
import { getOperationUsageAction } from "@/app/actions/operation-usage-action";
import { hasRoom, usageLine, type OperationUsage as Usage } from "@/lib/operation-limits";

/**
 * Cuántas operaciones (reservas + pedidos) lleva el cliente. Cuenta gratuita: "Hoy 1 de 2 · Esta semana 4 de 10".
 * Elite: insignia "Operaciones sin límite". No muestra nada mientras el interruptor de límites esté apagado
 * (operation_limits.enabled) ni si no se pudo leer el uso.
 */
export function OperationUsage({ variant = "card", refreshKey }: { variant?: "card" | "inline"; refreshKey?: unknown }) {
    const [usage, setUsage] = useState<Usage | null>(null);

    useEffect(() => {
        let cancelled = false;
        getOperationUsageAction().then(({ usage }) => { if (!cancelled) setUsage(usage); }).catch(() => {});
        return () => { cancelled = true; };
    }, [refreshKey]);

    if (!usage || !usage.enabled) return null;

    if (usage.elite) {
        return (
            <div className={variant === "card"
                ? "flex items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3"
                : "flex items-center gap-2 text-xs font-bold text-indigo-700"}>
                <Crown className="w-4 h-4 text-indigo-600 shrink-0" />
                <span className={variant === "card" ? "text-sm font-black text-indigo-900" : undefined}>Operaciones sin límite</span>
            </div>
        );
    }

    const room = hasRoom(usage);
    if (variant === "inline") {
        return (
            <p className={`text-xs font-bold ${room ? "text-slate-500" : "text-red-600"}`} role="status">
                {usageLine(usage)}
            </p>
        );
    }
    return (
        <div className={`rounded-2xl border px-4 py-3 space-y-1 ${room ? "border-slate-200 bg-white" : "border-red-200 bg-red-50"}`}>
            <div className="flex items-center gap-2 text-sm font-black text-slate-900">
                <Gauge className="w-4 h-4 text-slate-500 shrink-0" />
                Tus operaciones
            </div>
            <p className="text-sm font-bold text-slate-700" role="status">{usageLine(usage)}</p>
            <p className="text-xs text-slate-500">
                Cuentan tus reservas y tus pedidos. {room ? "Con Elite no tienes límite." : "Se libera el cupo pronto; con Elite no tienes límite."}
            </p>
        </div>
    );
}
