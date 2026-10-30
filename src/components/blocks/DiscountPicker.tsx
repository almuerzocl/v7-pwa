"use client";

import { useEffect } from "react";
import { Tag } from "lucide-react";
import { trackPlatformEvent } from "@/lib/platform-events";
import { formatDiscountAmount, DISCOUNTS_UNAVAILABLE_MESSAGE, type InstitutionDiscount } from "@/lib/core-business/discounts";

interface DiscountPickerProps {
    /** "reserva" | "pedido": se usa en los textos (nunca "compra"). */
    serviceLabel: "reserva" | "pedido";
    discounts: InstitutionDiscount[];
    /** El servicio de descuentos no respondió: se avisa sin bloquear. */
    unavailable: boolean;
    selected: InstitutionDiscount | null;
    accepted: boolean;
    onSelect: (discount: InstitutionDiscount | null) => void;
    onAccept: () => void;
}

/**
 * Selección de descuento compartida por la reserva (ReservationWizard) y el pedido (cart/page.tsx):
 * muestra TODOS los descuentos vigentes y deja elegir uno o ninguno antes de enviar.
 */
export function DiscountPicker({ serviceLabel, discounts, unavailable, selected, accepted, onSelect, onAccept }: DiscountPickerProps) {
    const surface = serviceLabel === "reserva" ? "wizard" : "cart";
    const kind = serviceLabel === "reserva" ? "reservation" : "order";

    // Cuántos clientes VEN cada descuento (una vez por sesión) y cuántos lo aplican o lo quitan: mide el embudo de los descuentos.
    useEffect(() => {
        for (const d of discounts) trackPlatformEvent("discount_view", { discountId: d.discount_id, step: surface, props: { kind }, once: true });
    }, [discounts, surface, kind]);

    const handleSelect = (d: InstitutionDiscount | null) => {
        if (d === null && selected) trackPlatformEvent("discount_remove", { discountId: selected.discount_id, step: surface, props: { kind } });
        onSelect(d);
    };
    const handleAccept = () => {
        if (selected) trackPlatformEvent("discount_apply", { discountId: selected.discount_id, step: surface, props: { kind } });
        onAccept();
    };

    if (unavailable && discounts.length === 0) {
        return (
            <div className="bg-muted/50 border border-border rounded-[1.25rem] px-4 py-3 text-xs text-muted-foreground flex items-start gap-2">
                <Tag className="w-4 h-4 shrink-0 mt-0.5" />
                <p>{DISCOUNTS_UNAVAILABLE_MESSAGE} Puedes continuar con tu {serviceLabel} sin descuento.</p>
            </div>
        );
    }
    if (discounts.length === 0) return null;

    return (
        <div className="space-y-3 bg-emerald-50/50 border border-emerald-200 rounded-[1.25rem] p-5">
            <label className="text-sm font-bold text-foreground flex items-center gap-2">
                <Tag className="w-4 h-4 text-emerald-600" /> Descuentos Disponibles
            </label>
            <p className="text-xs text-muted-foreground">Selecciona un descuento si deseas aplicarlo:</p>
            <div className="space-y-2">
                <button
                    type="button"
                    onClick={() => handleSelect(null)}
                    className={`w-full text-left p-3 rounded-xl border-2 transition-all ${!selected ? 'border-primary bg-primary/5' : 'border-border bg-card'}`}
                >
                    <span className="font-bold text-sm">No quiero descuento</span>
                </button>
                {discounts.map((d) => (
                    <button
                        type="button"
                        key={d.discount_id}
                        onClick={() => handleSelect(d)}
                        className={`w-full text-left p-3 rounded-xl border-2 transition-all ${selected?.discount_id === d.discount_id ? 'border-emerald-500 bg-emerald-50' : 'border-border bg-card'}`}
                    >
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                {d.institution_logo_url && (
                                    <img src={d.institution_logo_url} alt="" className="w-8 h-8 rounded-lg object-contain bg-white border border-border p-0.5" />
                                )}
                                <div>
                                    <p className="font-bold text-sm">{d.institution_name}</p>
                                    <p className="text-xs text-muted-foreground">{d.discount_name}</p>
                                    {d.conditions && <p className="text-xs text-muted-foreground mt-0.5">{d.conditions}</p>}
                                </div>
                            </div>
                            <span className="bg-emerald-600 text-white px-3 py-1 rounded-xl font-bold text-sm shrink-0 ml-2">
                                {formatDiscountAmount(d.amount, d.amount_type)}
                            </span>
                        </div>
                    </button>
                ))}
            </div>
            {selected && !accepted && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
                    <p className="text-xs text-amber-800 font-medium leading-relaxed">
                        El restaurante validará el descuento de acuerdo a los requisitos establecidos por la institución, y este será otorgado si cumple con todas las normas establecidas para el descuento.
                    </p>
                    <button
                        type="button"
                        onClick={handleAccept}
                        className="w-full py-2.5 bg-amber-600 text-white rounded-xl font-bold text-sm hover:bg-amber-700 transition-colors"
                    >
                        OK, Entendido
                    </button>
                </div>
            )}
            {selected && accepted && (
                <div className="bg-emerald-100 rounded-xl px-4 py-2 text-xs font-bold text-emerald-700 flex items-center gap-2">
                    <Tag className="w-3.5 h-3.5" />
                    Descuento seleccionado: {selected.institution_name} / {formatDiscountAmount(selected.amount, selected.amount_type)}
                </div>
            )}
        </div>
    );
}
