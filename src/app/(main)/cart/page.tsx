"use client";

import { useState, useEffect } from "react";
import { useCart } from "@/context/CartContext";
import { Trash2, Plus, Minus, ShoppingBag, ArrowLeft, ChevronRight, AlertCircle, Clock, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { CheckoutEngine } from "@/lib/core-business/checkout-engine";
import { formatCurrency } from "@/lib/core-business/ui-helpers";
import { BlockingToast } from "@/components/blocks/BlockingToast";
import { supabase } from "@/lib/supabase";
import { checkAvailability, formatShortage, parseStockError } from "@/lib/inventory";
import { createTakeawayOrderRequest } from "@/lib/takeaway/create-takeaway-order-client";
import { OperationLimitError } from "@/lib/operation-limits";
import { OrderPriceError } from "@/lib/takeaway/order-price-error";
import { applyServerLines, keyOf } from "@/lib/cart-lines";
import { optionsSummary } from "@/lib/menu-options";
import { OperationUsage } from "@/components/OperationUsage";
import { toast } from "react-hot-toast";
import { trackTakeawayStart, trackTakeawayConfirm } from '@/lib/ga4';
import { trackClientEvent } from '@/lib/client-events';
import { trackPlatformEvent, trackFailure } from '@/lib/platform-events';
import { loadEligibleDiscounts, type InstitutionDiscount } from '@/lib/core-business';
import { DiscountPicker } from '@/components/blocks/DiscountPicker';
import { v4 as uuidv4 } from 'uuid';
// Dynamic import used below for performance

export default function CartPage() {
    const { items, removeFromCart, updateQuantity, total, itemCount, clearCart, replaceItems } = useCart();
    const { user, profile, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!authLoading && !user) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        }
    }, [user, authLoading, router, pathname]);
    const [loading, setLoading] = useState(false);
    const [toastConfig, setToastConfig] = useState({
        isOpen: false,
        title: "",
        message: "",
        type: "loading" as "loading" | "success" | "error"
    });
    
    const [pickupTime, setPickupTime] = useState<string>("");
    const [availableSlots, setAvailableSlots] = useState<string[]>([]);
    const [slotsLoading, setSlotsLoading] = useState(true);
    const [specialRequests, setSpecialRequests] = useState<string>("");
    const [institutionDiscounts, setInstitutionDiscounts] = useState<InstitutionDiscount[]>([]);
    const [discountsUnavailable, setDiscountsUnavailable] = useState(false);
    const [selectedDiscount, setSelectedDiscount] = useState<InstitutionDiscount | null>(null);
    const [discountDisclaimerAccepted, setDiscountDisclaimerAccepted] = useState(false);

    const restaurantId = items[0]?.restaurantId;
    const restaurantName = items[0]?.restaurantName;

    // Takeaway rule: only one restaurant per order. Flag items whose restaurant differs from the first item's.
    const hasMixedRestaurants = items.length > 0 && items.some(i => i.restaurantId !== restaurantId);
    const isMismatchedItem = (itemRestaurantId: string) => hasMixedRestaurants && itemRestaurantId !== restaurantId;

    // GA4: Track takeaway intent once on mount when items are ready
    useEffect(() => {
        if (restaurantId) {
            trackTakeawayStart(restaurantId, restaurantName || 'Restaurante');
            trackClientEvent('order_start', restaurantId, { surface: 'cart' });
            trackPlatformEvent('cart_view', { restaurantId, props: { count: items.length }, once: true });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [restaurantId]);

    // Load matching institution discounts for takeaway
    useEffect(() => {
        if (!restaurantId || !user) return;
        let cancelled = false;
        loadEligibleDiscounts(restaurantId, 'takeaway').then(({ discounts, unavailable }) => {
            if (cancelled) return;
            setInstitutionDiscounts(discounts);
            setDiscountsUnavailable(unavailable);
            setSelectedDiscount(null);
            setDiscountDisclaimerAccepted(false);
        });
        return () => { cancelled = true; };
    }, [restaurantId, user]);

    // Load takeaway slots via API route (not server action — immune to CDN cache)
    useEffect(() => {
        if (!restaurantId) {
            setSlotsLoading(false);
            return;
        }

        setSlotsLoading(true);
        let cancelled = false;

        fetch(`/api/takeaway-slots?restaurantId=${restaurantId}`)
            .then(r => r.json())
            .then(res => {
                if (cancelled) return;
                if (res.success && res.slots) {
                    setAvailableSlots(res.slots);
                    if (res.slots.length > 0) setPickupTime(res.slots[0]);
                } else {
                    console.warn("[Cart] No slots returned:", res.error || 'empty');
                    setAvailableSlots([]);
                }
            })
            .catch(err => console.error("[Cart] Slots fetch error:", err))
            .finally(() => { if (!cancelled) setSlotsLoading(false); });

        return () => { cancelled = true; };
    }, [restaurantId]);

    const handleCheckout = async () => {
        if (!user || !profile) {
            toast.error("Debes iniciar sesión para realizar un pedido");
            return;
        }

        if (items.length === 0) return;

        if (hasMixedRestaurants) {
            toast.error("Los pedidos para llevar deben ser uno por cada restaurante. Por favor, retire los productos marcados e intente nuevamente");
            return;
        }

        if (!slotsLoading && availableSlots.length === 0) {
            toast.error("El restaurante ya no recibe pedidos para hoy");
            return;
        }

        if (!pickupTime) {
            toast.error("Por favor, selecciona un horario de retiro");
            return;
        }

        if (selectedDiscount && !discountDisclaimerAccepted) {
            toast.error("Confirma el aviso del descuento con \"OK, Entendido\" o elige \"No quiero descuento\"");
            return;
        }

        trackPlatformEvent('checkout_start', { restaurantId, props: { kind: 'order' } });
        setLoading(true);

        // Stock: verificacion previa (UX) con el stock real del servidor; el guard de la base es la garantia
        try {
            const shortages = await checkAvailability(supabase, items);
            if (shortages.length > 0) {
                shortages.forEach((sh) => toast.error(formatShortage(sh)));
                setLoading(false);
                return;
            }
        } catch (err) {
            console.error("[Cart] Stock check error:", err);
            toast.error("No pudimos verificar el stock. Intenta nuevamente.");
            setLoading(false);
            return;
        }

        setToastConfig({
            isOpen: true,
            title: "Procesando Pedido",
            message: "Estamos validando tu carrito y beneficios de cuenta...",
            type: "loading"
        });

        try {
            // 1. Motor de Negocio: Preparar datos
            const safeProfile = CheckoutEngine.getSafeProfile(user, profile);
            const sessionInfo = CheckoutEngine.prepareSessionData(safeProfile);

            // 2. Motor de Negocio: Calcular reputación
            const dailyReputation = await CheckoutEngine.calculateDailyReputation(user.id, 'takeaway');

            // 3. Motor de Negocio: Beneficios de Cuenta
            const restaurantId = items[0].restaurantId;
            const benefits = CheckoutEngine.applyAccountBenefits({ user: safeProfile, restaurantId });

            // Descuento elegido (solo cuenta si el cliente aceptó el aviso). El servidor lo revalida al crear el
            // pedido y es quien deja la observación del descuento: aquí va solo el texto del cliente.
            const chosenDiscount = selectedDiscount && discountDisclaimerAccepted ? selectedDiscount : null;
            const finalSpecialRequests = specialRequests.trim();

            // 4. Insert order with ALL snapshots (Requires applying FINAL_V5_SCHEMA_REPAIR.sql)
            const orderPayload: Record<string, unknown> = {
                user_id: user.id,
                restaurant_id: restaurantId,
                items: items,
                total_amount: total,
                status: "PENDIENTE",
                customer_name: sessionInfo.fullName,
                customer_phone: sessionInfo.contactPhone,
                unique_code: uuidv4().split('-')[0].toUpperCase(),
                user_reputation_snapshot: dailyReputation.score,
                account_type_snapshot: safeProfile.account_type,
                benefits_snapshot: benefits,
                discount_data_snapshot: chosenDiscount ? institutionDiscounts : null,
                metadata: {
                    source: 'pwa-v5',
                    reputation_level: dailyReputation.level,
                    pickup_time: pickupTime,
                    special_requests: finalSpecialRequests || null,
                    applied_discount_id: chosenDiscount?.discount_id || null
                },
                timestamps: {
                    'SOLICITADO': { at: new Date().toISOString() },
                    'PENDIENTE': { at: new Date().toISOString() }
                }
            };

            // El servidor revalida el descuento y es quien deja la observación; si ya no era vigente (o el
            // servicio de descuentos no responde) el pedido se crea sin descuento y se avisa.
            const { order, discountDropped } = await createTakeawayOrderRequest(orderPayload);
            trackPlatformEvent('checkout_submit', { restaurantId, refId: order.id, discountId: chosenDiscount?.discount_id, step: discountDropped ? 'discount_dropped' : 'ok', props: { kind: 'order', result: 'ok' } });

            setToastConfig({
                isOpen: true,
                title: "¡Pedido Recibido!",
                message: "Tu pedido ha sido enviado al restaurante. Revisa la sección 'Mis Pedidos' para ver el estado."
                    + (discountDropped ? ` ${discountDropped.message}` : ""),
                type: "success"
            });

            // Aviso INTERNO al restaurante (para que pueda aprobar). El correo "Pedido confirmado" NO sale desde aquí: lo envía
            // el servidor cuando el pedido queda APROBADA (autoaprobado o aprobado por el restaurante).
            import("@/lib/notifications").then(({ notifyRestaurantAdmin }) => {
                notifyRestaurantAdmin({
                    id: order.id,
                    restaurantId: restaurantId,
                    restaurantName: items[0].restaurantName || 'Almuerzo.cl',
                    dateTime: new Date().toISOString(),
                    itemCount: itemCount,
                    guestName: sessionInfo.fullName,
                    guestEmail: user.email || '',
                    guestPhone: sessionInfo.contactPhone,
                    type: 'order',
                }).catch(err => console.error("Notification background error:", err));
            });

            // GA4: Track takeaway order confirmed
            trackTakeawayConfirm(restaurantId, items[0].restaurantName || 'Restaurante', total, itemCount);

            // Clear cart after success
            clearCart();

            // Wait a bit so they see the success toast before redirecting
            setTimeout(() => {
                router.push("/orders");
            }, 2500);

        } catch (err: any) {
            console.error("Checkout error:", err);
            trackFailure('checkout_error', err, { restaurantId, props: { kind: 'order' } });
            if (err instanceof OrderPriceError) {
                // El servidor recalcula el precio y valida las opciones. Si cambió el precio, el carrito se actualiza y el cliente confirma de nuevo
                // (nunca se crea un pedido con un total que el cliente no vio). Si una opción ya no sirve, se pide quitar ese plato.
                if (err.hint === 'price_mismatch') {
                    replaceItems(applyServerLines(items, err.lines ?? []));
                    setToastConfig({ isOpen: true, title: "Actualizamos los precios", message: "Los precios de tu pedido cambiaron. Revisa el nuevo total y vuelve a confirmar.", type: "error" });
                } else {
                    setToastConfig({ isOpen: true, title: "Revisa tu pedido", message: `${err.message}. Quita ese plato y vuelve a agregarlo desde la carta.`, type: "error" });
                }
                return;
            }
            if (err instanceof OperationLimitError) {
                setToastConfig({ isOpen: true, title: "Llegaste a tu límite", message: err.message, type: "error" });
                return;
            }
            setToastConfig({
                isOpen: true,
                title: "Error en el Pedido",
                message: parseStockError(err) || err.message || "No pudimos procesar tu pedido. Intenta nuevamente.",
                type: "error"
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="w-full max-w-lg mx-auto p-4 space-y-6 pb-40">
            <header className="flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => router.back()} className="rounded-full">
                    <ArrowLeft className="w-5 h-5" />
                </Button>
                <div className="space-y-0.5">
                    <h1 className="text-2xl font-black tracking-tight text-foreground">Tu Pedido</h1>
                    <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">{itemCount} Items seleccionados</p>
                </div>
            </header>

            {items.length > 0 ? (
                <>
                    <div className="space-y-3">
                        {hasMixedRestaurants && (
                            <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-2xl p-4 flex items-start gap-3">
                                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                                <p className="text-xs font-semibold leading-snug">
                                    Los pedidos para llevar deben ser uno por cada restaurante. Por favor, retire los productos marcados e intente nuevamente.
                                </p>
                            </div>
                        )}
                        {items.map((item) => (
                            <div
                                key={keyOf(item)}
                                className={`rounded-3xl p-4 flex gap-4 items-center border ${
                                    isMismatchedItem(item.restaurantId)
                                        ? "bg-destructive/5 border-destructive ring-2 ring-destructive/40"
                                        : "bg-card border-border"
                                }`}
                            >
                                <div className="w-20 h-20 bg-muted rounded-2xl overflow-hidden shrink-0">
                                    {item.imageUrl ? (
                                        <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-muted-foreground/20">
                                            <ShoppingBag className="w-8 h-8" />
                                        </div>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0 space-y-1">
                                    <div className="flex justify-between items-start gap-2">
                                        <h3 className="font-bold text-sm truncate">{item.name}</h3>
                                        <button
                                            onClick={() => removeFromCart(keyOf(item))}
                                            aria-label={`Quitar ${item.name}`}
                                            className="text-muted-foreground hover:text-destructive transition-colors"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                    {item.options && item.options.length > 0 && (
                                        <p className="text-xs text-muted-foreground leading-snug break-words">{optionsSummary(item.options)}</p>
                                    )}
                                    <p className="text-xs text-muted-foreground font-bold uppercase">{item.restaurantName}</p>
                                    <div className="flex justify-between items-center pt-2">
                                        <span className="font-extrabold text-primary text-base">
                                            {formatCurrency(item.price * item.quantity)}
                                        </span>
                                        <div className="flex items-center bg-muted/50 rounded-xl p-1 gap-2">
                                            <button
                                                onClick={() => updateQuantity(keyOf(item), item.quantity - 1)}
                                                aria-label={`Menos ${item.name}`}
                                                className="w-7 h-7 flex items-center justify-center rounded-lg bg-background border border-border/50 shadow-sm active:scale-90 transition-transform"
                                            >
                                                <Minus className="w-3 h-3" />
                                            </button>
                                            <span className="text-xs font-black min-w-[20px] text-center">{item.quantity}</span>
                                            <button
                                                onClick={() => updateQuantity(keyOf(item), item.quantity + 1)}
                                                aria-label={`Más ${item.name}`}
                                                className="w-7 h-7 flex items-center justify-center rounded-lg bg-primary text-white shadow-sm active:scale-90 transition-transform"
                                            >
                                                <Plus className="w-3 h-3" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="bg-primary/5 rounded-[2.5rem] p-6 space-y-4 border border-primary/10">
                        <div className="flex justify-between items-center">
                            <span className="text-sm font-semibold text-muted-foreground">Subtotal</span>
                            <span className="font-bold text-foreground">{formatCurrency(total)}</span>
                        </div>
                        <div className="pt-4 border-t border-primary/10 flex justify-between items-center">
                            <div className="space-y-1">
                                <span className="text-lg font-black text-foreground block">Total a pagar</span>
                                <span className="text-xs uppercase font-bold text-muted-foreground tracking-widest leading-none block">
                                    Pago y retiro presencial
                                </span>
                            </div>
                            <span className="text-2xl font-black text-primary">
                                {formatCurrency(total)}
                            </span>
                        </div>
                    </div>

                    <div className="space-y-3 mt-4">
                        <label className="text-sm font-bold text-muted-foreground flex items-center gap-2 px-1">
                            <Clock className="w-4 h-4" /> Horario de Retiro
                        </label>
                        {slotsLoading ? (
                            <div className="h-14 bg-muted animate-pulse rounded-[1.25rem]" />
                        ) : availableSlots.length > 0 ? (
                            <div className="relative">
                                <select
                                    value={pickupTime}
                                    onChange={(e) => setPickupTime(e.target.value)}
                                    className="w-full h-14 bg-card border border-border rounded-[1.25rem] px-5 font-bold text-foreground appearance-none shadow-sm focus:outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    {availableSlots.map(s => (
                                        <option key={s} value={s}>{s} hrs</option>
                                    ))}
                                </select>
                                <ChevronDown className="absolute right-5 top-1/2 -translate-y-1/2 w-5 h-5 pointer-events-none text-muted-foreground" />
                            </div>
                        ) : (
                            <div className="bg-destructive/10 text-destructive text-sm font-bold p-4 rounded-[1.25rem] flex items-center gap-3">
                                <AlertCircle className="w-5 h-5 shrink-0" />
                                <p>El restaurante ya no recibe pedidos para hoy.</p>
                            </div>
                        )}
                    </div>

                    {/* Institution Discount Selection */}
                    <div className="mt-4">
                        <DiscountPicker
                            serviceLabel="pedido"
                            discounts={institutionDiscounts}
                            unavailable={discountsUnavailable}
                            selected={selectedDiscount}
                            accepted={discountDisclaimerAccepted}
                            onSelect={(d) => { setSelectedDiscount(d); setDiscountDisclaimerAccepted(false); }}
                            onAccept={() => setDiscountDisclaimerAccepted(true)}
                        />
                    </div>

                    <div className="space-y-3 mt-4">
                        <label className="text-sm font-bold text-muted-foreground flex items-center gap-2 px-1">
                            Solicitudes Especiales
                        </label>
                        <div className="relative">
                            <textarea
                                value={specialRequests}
                                onChange={(e) => setSpecialRequests(e.target.value.slice(0, 300))}
                                placeholder="Ej: Sin cebolla, extra salsa, alergia a frutos secos..."
                                maxLength={300}
                                rows={3}
                                className="w-full bg-card border border-border rounded-[1.25rem] px-5 py-4 font-medium text-sm text-foreground resize-none shadow-sm focus:outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring placeholder:text-muted-foreground/50"
                            />
                            <span className="absolute bottom-3 right-4 text-xs font-bold text-muted-foreground/50">
                                {specialRequests.length}/300
                            </span>
                        </div>
                    </div>

                    <div className="mt-4"><OperationUsage variant="inline" /></div>
                    <Button
                        onClick={handleCheckout}
                        disabled={loading || (!slotsLoading && availableSlots.length === 0)}
                        className="w-full h-16 rounded-[1.5rem] font-black text-lg gap-3 shadow-xl shadow-primary/20 transition-all active:scale-[0.98] mt-6"
                    >
                        Confirmar Pedido
                        <ChevronRight className="w-5 h-5" />
                    </Button>
                </>
            ) : (
                <div className="py-20 text-center space-y-6">
                    <div className="bg-muted w-24 h-24 rounded-full flex items-center justify-center mx-auto">
                        <ShoppingBag className="w-10 h-10 text-muted-foreground/30" />
                    </div>
                    <div className="space-y-2">
                        <h3 className="font-bold text-xl">Tu carro está vacío</h3>
                        <p className="text-sm text-muted-foreground max-w-[200px] mx-auto">
                            Agrega platos de tus restaurantes favoritos para empezar.
                        </p>
                    </div>
                    <Link href="/">
                        <Button variant="outline" className="rounded-2xl h-12 px-8 font-bold border-primary text-primary hover:bg-primary/5 transition-colors">
                            Ver Restaurantes
                        </Button>
                    </Link>
                </div>
            )}

            <BlockingToast
                isOpen={toastConfig.isOpen}
                title={toastConfig.title}
                message={toastConfig.message}
                type={toastConfig.type}
                onClose={() => setToastConfig(prev => ({ ...prev, isOpen: false }))}
            />
        </div>
    );
}

