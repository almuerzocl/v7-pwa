"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ShoppingBag, Plus, Store, Clock, ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/core-business/ui-helpers";
import { Button } from "@/components/ui/button";
import { useCart } from "@/context/CartContext";
import { Badge } from "@/components/ui/badge";
import { trackClientEvent } from "@/lib/client-events";
import { buildMenuSections, type MenuCategoryRow } from "@/lib/menu-sections";
import { baseUnitPrice, groupUnsatisfiable, unitPrice, type MenuOptionGroup } from "@/lib/menu-options";
import { buildSelectedOptions, cartLineKey } from "@/lib/cart-lines";
import { OptionSheet } from "@/components/menu/OptionSheet";
import { toast } from "react-hot-toast";

interface Props {
    restaurant: { id: string; name: string; logo_url?: string; cover_image_url?: string; has_takeaway?: boolean };
    menuItems: any[];
    categories?: MenuCategoryRow[];
    /** Grupos de opciones por plato (migración 047), ya ordenados. */
    optionGroups?: Record<string, MenuOptionGroup[]>;
}

export default function MenuClient({ restaurant, menuItems, categories = [], optionGroups = {} }: Props) {
    const router = useRouter();
    const { addToCart, itemCount } = useCart();

    // Medición: ver la carta del local.
    useEffect(() => {
        trackClientEvent('menu_view', restaurant.id, { surface: 'menu' });
    }, [restaurant.id]);

    // Secciones en el orden que define el restaurante (reglas en lib/menu-sections.ts). Un cambio de orden se ve en la
    // siguiente carga de la carta: la página es dinámica y el service worker no cachea navegaciones ni RSC.
    const sections = useMemo(() => buildMenuSections(categories, menuItems), [categories, menuItems]);
    const [activeId, setActiveId] = useState<string | null>(sections[0]?.id ?? null);
    const navRef = useRef<HTMLElement | null>(null);
    const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Marca la categoría activa al desplazarse: la primera sección cuyo borde superior ya pasó bajo la cabecera fija.
    useEffect(() => {
        if (sections.length < 2 || typeof IntersectionObserver === "undefined") return;
        const visible = new Set<string>();
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) {
                const id = (e.target as HTMLElement).dataset.sectionId!;
                if (e.isIntersecting) visible.add(id); else visible.delete(id);
            }
            const first = sections.find((sec) => visible.has(sec.id));
            if (first) setActiveId(first.id);
        }, { rootMargin: "-136px 0px -55% 0px", threshold: 0 });
        sections.forEach((sec) => { const el = document.getElementById(`seccion-${sec.id}`); if (el) io.observe(el); });
        return () => io.disconnect();
    }, [sections]);

    // Mantiene el chip activo a la vista dentro de la barra (desplazamiento horizontal propio, sin mover la página).
    useEffect(() => {
        const nav = navRef.current;
        const chip = activeId ? nav?.querySelector<HTMLElement>(`[data-chip-id="${activeId}"]`) : null;
        if (nav && chip) nav.scrollTo({ left: chip.offsetLeft - nav.clientWidth / 2 + chip.clientWidth / 2, behavior: reduceMotion() ? "auto" : "smooth" });
    }, [activeId]);

    const goToSection = (id: string) => {
        setActiveId(id);
        document.getElementById(`seccion-${id}`)?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
    };

    const [sheetItem, setSheetItem] = useState<any | null>(null);
    const groupsOf = (item: any): MenuOptionGroup[] => optionGroups[item.id] ?? [];

    const addPlain = useCallback((item: any, groups: MenuOptionGroup[], optionIds: string[], quantity: number) => {
        const base = baseUnitPrice({ price: item.price || 0, takeaway_price: item.takeaway_price });
        addToCart({
            id: item.id,
            name: item.name,
            price: unitPrice(base, groups, optionIds),
            basePrice: base,
            lineKey: cartLineKey(item.id, optionIds),
            options: buildSelectedOptions(groups, optionIds),
            quantity,
            imageUrl: item.image_url,
            restaurantId: restaurant.id,
            restaurantName: restaurant.name
        });
    }, [restaurant, addToCart]);

    // Con opciones se abre la hoja; sin ellas se agrega directo, como siempre.
    const handleAddToCart = (item: any) => {
        if (groupsOf(item).length > 0) setSheetItem(item);
        else addPlain(item, [], [], 1);
    };

    return (
        <div className="w-full h-full max-w-lg mx-auto pb-48 bg-slate-50 min-h-screen">
            <div className="sticky top-0 z-50 bg-white/90 backdrop-blur-xl border-b border-slate-100 flex flex-col shadow-sm">
                <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Button variant="ghost" size="icon" onClick={() => router.back()} className="rounded-full hover:bg-slate-100 h-10 w-10">
                            <ArrowLeft className="w-5 h-5" />
                        </Button>
                        <div className="flex flex-col">
                            <h1 className="text-lg font-black tracking-tight leading-none">{restaurant.name}</h1>
                            <div className="flex items-center gap-1.5 mt-0.5">
                                <Clock className="w-3 h-3 text-emerald-600" />
                                <span className="text-xs font-bold text-emerald-600 uppercase tracking-widest">Disponible para hoy</span>
                            </div>
                        </div>
                    </div>
                    <Badge variant="outline" className="rounded-full border-blue-100 bg-blue-50 text-blue-700 font-bold px-3 py-1">
                        TAKEAWAY
                    </Badge>
                </div>
                {sections.length > 1 && (
                    <nav ref={navRef} aria-label="Categorías de la carta" className="flex gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {sections.map((sec) => (
                            <button
                                key={sec.id}
                                type="button"
                                data-chip-id={sec.id}
                                aria-current={activeId === sec.id ? "true" : undefined}
                                onClick={() => goToSection(sec.id)}
                                className={`h-11 shrink-0 rounded-full border px-4 text-sm font-bold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                                    activeId === sec.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                                }`}
                            >
                                {sec.name}
                            </button>
                        ))}
                    </nav>
                )}
            </div>

            <div className="p-4 space-y-6 mt-4">
                <div className="flex items-center justify-between px-2">
                    <h2 className="text-xl font-black text-slate-800 tracking-tight uppercase">Platos Disponibles</h2>
                    <Badge variant="secondary" className="bg-slate-200/50 text-slate-600 font-bold">
                        {menuItems.length} opciones
                    </Badge>
                </div>

                {sections.length > 0 ? (
                    <div className="space-y-8">
                        {sections.map((sec) => (
                            <section key={sec.id} id={`seccion-${sec.id}`} data-section-id={sec.id} aria-labelledby={`titulo-${sec.id}`} className="scroll-mt-36">
                                <h3 id={`titulo-${sec.id}`} className="mb-3 px-2 text-sm font-black uppercase tracking-widest text-slate-500">
                                    {sec.name} <span className="font-bold text-slate-400">· {sec.items.length}</span>
                                </h3>
                                <div className="grid grid-cols-1 gap-4">
                                    {sec.items.map(item => (
                            <div
                                key={item.id}
                                className="bg-white p-4 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md hover:border-primary/20 transition-all group overflow-hidden relative"
                            >
                                <div className="flex gap-3 items-start">
                                    {item.image_url && (
                                        <div className="w-20 h-20 rounded-[1.2rem] overflow-hidden shrink-0 border border-slate-100">
                                            <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" loading="lazy" />
                                        </div>
                                    )}
                                    <div className="flex-1 min-w-0 space-y-1.5">
                                        <div className="space-y-0.5">
                                            <div className="flex items-start gap-1.5 flex-wrap">
                                                <h4 className="font-black text-base text-slate-900 leading-tight uppercase tracking-tight break-words">{item.name}</h4>
                                                {item.is_menu_del_dia && (
                                                    <Badge className="bg-orange-500 text-white border-none p-1 rounded-full shrink-0">
                                                        <Store className="w-3 h-3" />
                                                    </Badge>
                                                )}
                                            </div>
                                            {groupsOf(item).length > 0 && <span className="block text-xs font-bold text-slate-600">Con opciones</span>}
                                            <p className="text-xs text-slate-500 font-medium leading-relaxed line-clamp-2">
                                                {item.description || "Un delicioso plato artesanal preparado por nuestros mejores chefs para disfrutar donde quieras."}
                                            </p>
                                        </div>

                                        <div className="flex items-center justify-between pt-1">
                                            <div className="flex items-center gap-3">
                                                <span className="text-lg font-black text-primary">
                                                    {formatCurrency(item.takeaway_price || item.price || 0)}
                                                </span>
                                                {item.takeaway_price && item.takeaway_price < item.price && (
                                                    <span className="text-xs font-bold text-slate-400 line-through">
                                                        {formatCurrency(item.price)}
                                                    </span>
                                                )}
                                            </div>
                                            {groupsOf(item).some(groupUnsatisfiable) ? (
                                                <span className="text-xs font-bold text-slate-600">No disponible por ahora</span>
                                            ) : (
                                                <Button
                                                    size="icon"
                                                    aria-label={groupsOf(item).length > 0 ? `Elegir opciones de ${item.name}` : `Agregar ${item.name}`}
                                                    className="rounded-2xl h-11 w-11 shrink-0 bg-primary shadow-lg shadow-primary/20 hover:scale-110 active:scale-95 transition-all text-white"
                                                    onClick={() => handleAddToCart(item)}
                                                >
                                                    <Plus className="w-5 h-5 stroke-[3]" />
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                ) : (
                    <div className="text-center py-32 px-6 bg-white rounded-[3rem] border border-dashed border-slate-200 shadow-inner space-y-6">
                        <div className="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center mx-auto ring-4 ring-slate-50/50">
                            <ShoppingBag className="w-12 h-12 text-slate-300" />
                        </div>
                        <div className="space-y-2">
                            <h3 className="text-2xl font-black text-slate-900 uppercase tracking-tight">Menú no detallado</h3>
                            <p className="text-sm text-slate-500 font-medium max-w-[240px] mx-auto italic">
                                Este restaurante aún no ha subido sus platos disponibles para retiro.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            className="rounded-2xl h-12 font-black uppercase text-xs tracking-widest"
                            onClick={() => router.back()}
                        >
                            Ver otros locales
                        </Button>
                    </div>
                )}
            </div>

            {sheetItem && (
                <OptionSheet
                    open
                    name={sheetItem.name}
                    basePrice={baseUnitPrice({ price: sheetItem.price || 0, takeaway_price: sheetItem.takeaway_price })}
                    groups={groupsOf(sheetItem)}
                    onClose={() => setSheetItem(null)}
                    onAdd={(ids, qty) => { addPlain(sheetItem, groupsOf(sheetItem), ids, qty); setSheetItem(null); toast.success(`${sheetItem.name} agregado al pedido`); }}
                />
            )}

            {itemCount > 0 && (
                <div className="fixed bottom-[88px] left-0 right-0 px-6 z-[10000] animate-in slide-in-from-bottom duration-500">
                    <div className="w-full max-w-lg mx-auto">
                        <Button
                            className="w-full h-16 bg-slate-900 text-white rounded-3xl font-black text-lg shadow-2xl flex items-center justify-between px-8 border-2 border-white/10 hover:bg-slate-800 transition-all hover:scale-[1.02] active:scale-95"
                            onClick={() => router.push('/cart')}
                        >
                            <div className="flex items-center gap-3">
                                <div className="bg-primary p-2 rounded-xl">
                                    <ShoppingBag className="w-5 h-5 text-white" />
                                </div>
                                <span className="uppercase tracking-tight">Tu Pedido ({itemCount})</span>
                            </div>
                            <ChevronRight className="w-6 h-6" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
