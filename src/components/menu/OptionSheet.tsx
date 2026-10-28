"use client";

import { useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/core-business/ui-helpers";
import { MAX_QUANTITY, unitPrice, type MenuOptionGroup } from "@/lib/menu-options";

export interface OptionSheetProps {
    open: boolean;
    name: string;
    basePrice: number;
    groups: MenuOptionGroup[];
    onClose: () => void;
    onAdd: (optionIds: string[], quantity: number) => void;
}

const hintOf = (g: MenuOptionGroup) =>
    g.kind === "single" ? "Elige 1" : g.min_select === g.max_select ? `Elige ${g.max_select}` : g.min_select > 0 ? `Elige de ${g.min_select} a ${g.max_select}` : `Elige hasta ${g.max_select}`;

// Hoja anclada ARRIBA (no abajo: la barra de navegación inferior de la app tapaba el botón «Agregar») para elegir las opciones de un plato: grupos con radios (una) o casillas (varias), precio vivo y errores por grupo.
// Es un diálogo modal (Radix): foco atrapado, Escape cierra, el foco vuelve al botón que lo abrió. Las opciones apagadas se ven
// pero no se pueden elegir; al llegar al máximo del grupo las demás casillas se deshabilitan.
export function OptionSheet({ open, name, basePrice, groups, onClose, onAdd }: OptionSheetProps) {
    const [selected, setSelected] = useState<Record<string, string[]>>({}); // group.id -> ids
    const [quantity, setQuantity] = useState(1);
    const [showErrors, setShowErrors] = useState(false);
    const groupRefs = useRef<Record<string, HTMLFieldSetElement | null>>({});

    const ids = useMemo(() => groups.flatMap((g) => selected[g.id] ?? []), [groups, selected]);
    const unit = unitPrice(basePrice, groups, ids);
    const missing = (g: MenuOptionGroup) => (selected[g.id]?.length ?? 0) < g.min_select;
    const firstInvalid = groups.find(missing);

    const setGroup = (g: MenuOptionGroup, next: string[]) => { setSelected((s) => ({ ...s, [g.id]: next })); };
    const toggle = (g: MenuOptionGroup, id: string, on: boolean) => {
        const cur = selected[g.id] ?? [];
        setGroup(g, on ? [...cur, id] : cur.filter((x) => x !== id));
    };

    const submit = () => {
        if (firstInvalid) {
            setShowErrors(true);
            const el = groupRefs.current[firstInvalid.id];
            el?.scrollIntoView({ block: "center", behavior: "smooth" });
            el?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
            return;
        }
        onAdd(ids, quantity);
    };

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
            <DialogContent className="top-4 bottom-auto left-0 right-0 mx-auto flex max-h-[calc(100dvh-6rem)] w-[calc(100%-1.5rem)] max-w-lg translate-x-0 translate-y-0 flex-col gap-0 rounded-3xl p-0 sm:rounded-3xl data-[state=closed]:slide-out-to-top-4 data-[state=open]:slide-in-from-top-4 data-[state=closed]:slide-out-to-left-0 data-[state=open]:slide-in-from-left-0">
                <div className="border-b border-slate-100 px-5 pb-3 pt-5 pr-12">
                    <DialogTitle className="text-lg font-black leading-tight">{name}</DialogTitle>
                    <DialogDescription className="text-xs text-slate-500">Elige las opciones de tu plato. El precio se actualiza al instante.</DialogDescription>
                </div>

                <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
                    {groups.map((g) => {
                        const chosen = selected[g.id] ?? [];
                        const atMax = g.kind === "multiple" && chosen.length >= g.max_select;
                        const err = showErrors && missing(g);
                        const errId = `err-${g.id}`;
                        return (
                            <fieldset key={g.id} ref={(el) => { groupRefs.current[g.id] = el; }} aria-describedby={err ? errId : undefined} className="min-w-0">
                                <legend className="mb-1 flex w-full items-center gap-2">
                                    <span className="text-sm font-black text-slate-900">{g.name}</span>
                                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${g.required ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}>{g.required ? "Obligatorio" : "Opcional"}</span>
                                    <span className="text-[11px] text-slate-600">{hintOf(g)}</span>
                                </legend>
                                <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
                                    {g.kind === "single" && !g.required && (
                                        <li>
                                            <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                                                <input type="radio" name={g.id} checked={chosen.length === 0} onChange={() => setGroup(g, [])} className="h-5 w-5 accent-slate-900" />
                                                <span className="flex-1 text-slate-700">Sin {g.name.toLowerCase()}</span>
                                            </label>
                                        </li>
                                    )}
                                    {g.options.map((o) => {
                                        const isOn = chosen.includes(o.id);
                                        const disabled = !o.is_available || (g.kind === "multiple" && atMax && !isOn);
                                        return (
                                            <li key={o.id}>
                                                <label className={`flex min-h-12 items-center gap-3 px-3 py-2 text-sm ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
                                                    {g.kind === "single" ? (
                                                        <input type="radio" name={g.id} checked={isOn} disabled={disabled} onChange={() => setGroup(g, [o.id])} className="h-5 w-5 accent-slate-900" />
                                                    ) : (
                                                        <input type="checkbox" checked={isOn} disabled={disabled} onChange={(e) => toggle(g, o.id, e.target.checked)} className="h-5 w-5 accent-slate-900" />
                                                    )}
                                                    <span className={`flex-1 ${o.is_available ? "text-slate-900" : "text-slate-500 line-through"}`}>{o.name}</span>
                                                    {!o.is_available ? <span className="text-xs font-bold text-slate-600">No disponible</span>
                                                        : o.price_delta > 0 ? <span className="text-sm font-bold text-slate-900">+{formatCurrency(o.price_delta)}</span> : null}
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                                {atMax && <p className="mt-1 text-[11px] text-slate-600">Llegaste al máximo de este grupo.</p>}
                                {err && <p id={errId} role="alert" className="mt-1 text-xs font-bold text-red-700">{g.min_select === 1 ? "Elige una opción para continuar." : `Elige al menos ${g.min_select} opciones para continuar.`}</p>}
                            </fieldset>
                        );
                    })}
                </div>

                <div className="flex items-center gap-3 border-t border-slate-100 bg-white px-5 py-3 pb-3">
                    <div className="flex items-center gap-1 rounded-2xl bg-slate-100 p-1" role="group" aria-label="Cantidad">
                        <button type="button" aria-label="Menos" disabled={quantity <= 1} onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="flex h-11 w-11 items-center justify-center rounded-xl bg-white shadow-sm disabled:opacity-40"><Minus className="h-4 w-4" /></button>
                        <span className="min-w-[2rem] text-center text-base font-black" aria-live="polite">{quantity}</span>
                        <button type="button" aria-label="Más" disabled={quantity >= MAX_QUANTITY} onClick={() => setQuantity((q) => Math.min(MAX_QUANTITY, q + 1))} className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white shadow-sm disabled:opacity-40"><Plus className="h-4 w-4" /></button>
                    </div>
                    <Button type="button" onClick={submit} className="h-12 flex-1 rounded-2xl text-base font-black">
                        Agregar · <span aria-live="polite" className="ml-1">{formatCurrency(unit * quantity)}</span>
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
