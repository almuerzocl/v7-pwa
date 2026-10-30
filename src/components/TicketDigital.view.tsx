/**
 * TicketDigital.view.tsx — presentación del ticket digital (reserva o pedido para llevar).
 *
 * ARCHIVO COMPARTIDO: es idéntico en restaurant-dashboard, pwa y public-tickets. No se edita
 * en un solo repo: cualquier cambio se aplica en bloque a los tres (copiar el archivo tal cual
 * y verificar con `diff`/`cmp` que siguen iguales). Todo lo que depende del repo (enlaces de
 * calendario, URL pública, datos del restaurante, indicadores de autoaprobación) entra por
 * props desde `TicketDigital.tsx`, que sí es propio de cada repo.
 */
import React from 'react';
import { MapPin, Calendar, Clock, Users, Tag, Phone, Mail, CreditCard, StickyNote, Percent, Ticket, Send } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { getBusinessStatusStyles, getBusinessStatusLabel, getInitials, formatCurrency } from '@/lib/core-business/ui-helpers';
import { cn } from '@/lib/utils';

export interface TicketContact {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
}

export interface TicketDigitalViewProps {
    res: any;
    showActions?: boolean;
    /** Enlaces "Importar a mi calendario" (solo reservas, con acciones visibles). */
    calendarLinks?: { google: string; ics: string } | null;
    /** URL base pública del ticket (para el acceso directo), sin barra final. */
    ticketUrl?: string;
    /** Datos del comensal si el repo los obtiene aparte; si no, se leen del registro. */
    contact?: TicketContact | null;
    /** Restaurante si el registro no lo trae anidado (res.restaurant). */
    restaurant?: { name?: string | null; logo_url?: string | null; address?: any; phone?: string | null } | null;
    /** Espacio reservado para contenido propio del repo (indicadores de autoaprobación). */
    extra?: React.ReactNode;
    /** Deja libre la esquina superior derecha cuando el ticket va en un modal con botón de cerrar. */
    reserveCloseButton?: boolean;
    /**
     * Si el repo lo entrega, cada invitado pendiente de una reserva CONFIRMADA muestra un botón para
     * enviarle su enlace personal de invitación (WhatsApp / hoja de compartir). Solo lo usa la PWA:
     * en los otros repos los ids de invitados no viajan al navegador.
     */
    onInviteGuest?: (guest: any) => void;
}

const LBL = 'text-[9px] uppercase font-extrabold tracking-wider text-muted-foreground leading-none';

/** Estado sobre fondo blanco: reutiliza solo el color de texto y borde del estilo central. */
function whiteStatusClasses(status: string) {
    const picked = getBusinessStatusStyles(status)
        .split(' ')
        .filter(c => /^(text|border)-/.test(c))
        .map(c => (c === 'text-white' ? 'text-zinc-800' : c))
        .join(' ');
    return cn('bg-white', picked);
}

function safeTime(iso: string) {
    try { return format(new Date(iso), 'HH:mm'); } catch { return '--:--'; }
}

export function TicketDigitalView({
    res, showActions = true, calendarLinks = null, ticketUrl = '', contact = null, restaurant = null, extra = null, reserveCloseButton = false, onInviteGuest,
}: TicketDigitalViewProps) {
    const isOrder = !!res?.items && Array.isArray(res.items) && res.items.length > 0 && !res.party_size && !res.guest_data;
    const kind = isOrder ? 'TAKEAWAY' : 'RESERVATION';

    // Una fecha mal formada no debe romper el ticket: se prueba en orden y se cae a "ahora".
    const parseValidDate = (raw: unknown): Date | null => {
        if (!raw) return null;
        const d = new Date(raw as any);
        return isNaN(d.getTime()) ? null : d;
    };
    const date = parseValidDate(res?.date_time) || parseValidDate(res?.created_at) || new Date();

    const rest = restaurant || res.restaurant || null;

    // ── Invitados: pueden venir como arreglo o como texto JSON ────────────────
    const guestDataRaw = res.guest_data || res.guests;
    const guestList: any[] = Array.isArray(guestDataRaw)
        ? guestDataRaw
        : (typeof guestDataRaw === 'string' ? (() => { try { const p = JSON.parse(guestDataRaw); return Array.isArray(p) ? p : []; } catch { return []; } })() : []);

    // ── Línea de tiempo ───────────────────────────────────────────────────────
    // Una entrada puede ser un texto suelto (checkin_at) en vez de {at: "..."}: "str".at es
    // String.prototype.at (una función, truthy), así que `value?.at || value` elegiría la función
    // y new Date(fn) rompería format(). toSafeDate lo descarta.
    const toSafeDate = (raw: unknown): Date | null => {
        if (!raw) return null;
        const candidate = raw && typeof raw === 'object' && 'at' in (raw as any) ? (raw as any).at : raw;
        if (typeof candidate !== 'string' && typeof candidate !== 'number') return null;
        const d = new Date(candidate);
        return isNaN(d.getTime()) ? null : d;
    };

    const timestamps = res.timestamps || {};
    const dynamicEvents = Object.entries(timestamps)
        .map(([key, value]) => ({ label: getBusinessStatusLabel(key, kind), dateObj: toSafeDate(value) }))
        .filter(e => e.dateObj !== null) as { label: string; dateObj: Date }[];

    const fallbackEventsRaw = isOrder ? [
        { label: getBusinessStatusLabel('PENDIENTE', 'TAKEAWAY'), date: res.created_at },
        { label: getBusinessStatusLabel('APROBADA', 'TAKEAWAY'), date: res.approved_at || res.metadata?.approved_at },
        { label: getBusinessStatusLabel('LISTO', 'TAKEAWAY'), date: res.ready_at || res.metadata?.ready_at },
        { label: getBusinessStatusLabel('ENTREGADO', 'TAKEAWAY'), date: res.completed_at || res.metadata?.completed_at },
    ] : [
        { label: getBusinessStatusLabel('PENDIENTE', 'RESERVATION'), date: res.created_at || res.metadata?.created_at },
        { label: getBusinessStatusLabel('CONFIRMADA', 'RESERVATION'), date: res.confirmed_at || res.metadata?.confirmed_at || res.approved_at },
        { label: getBusinessStatusLabel('COMPLETADA', 'RESERVATION'), date: res.completed_at || (res.status === 'COMPLETADA' ? (res.updated_at || res.metadata?.completed_at) : null) },
    ];
    const fallbackEvents = fallbackEventsRaw
        .map(e => ({ label: e.label, dateObj: toSafeDate(e.date) }))
        .filter(e => e.dateObj !== null) as { label: string; dateObj: Date }[];

    const timelineEvents = [...dynamicEvents, ...fallbackEvents]
        .filter((v, i, a) => a.findIndex(t => t.label.toLowerCase() === v.label.toLowerCase()) === i)
        .sort((x, y) => x.dateObj.getTime() - y.dateObj.getTime())
        .map(e => ({ label: e.label, date: e.dateObj.toISOString() }));

    // ── Restaurante ───────────────────────────────────────────────────────────
    const restaurantAddress = typeof rest?.address === 'object' && rest?.address !== null
        ? [`${rest.address.street || ''} ${rest.address.number || ''}`.trim(), rest.address.commune].filter(Boolean).join(', ')
        : (rest?.address || 'Dirección no disponible');
    const restaurantPhone = rest?.phone || null;

    // ── Comensal: organizador de la reserva o cliente del pedido ─────────────
    const organizer = !isOrder ? guestList.find((g: any) => g.is_organizer) : null;
    const dinerName = contact?.name || (isOrder ? res.customer_name : organizer?.name) || null;
    const dinerEmail = contact?.email || (isOrder ? (res.customer_email || res.metadata?.customer_email) : organizer?.email) || null;
    const dinerPhone = contact?.phone || (isOrder ? res.customer_phone : (organizer?.phone || res.customer_phone)) || null;
    const hasDiner = !!(dinerName || dinerEmail || dinerPhone);

    // ── Condición de pago, notas y descuento ──────────────────────────────────
    const paymentLabels: Record<string, string> = {
        individual: 'Cada uno paga lo suyo',
        organizer: 'El organizador invita',
        fixed: 'Cuota fija por persona',
    };
    const paymentLabel = !isOrder ? (paymentLabels[res.payment_method as string] || res.payment_method || null) : null;

    const metadata = typeof res.metadata === 'string' ? (() => { try { return JSON.parse(res.metadata || '{}'); } catch { return {}; } })() : (res.metadata || {});
    const specialNotes = res.special_requests || metadata.special_requests || res.notes || null;

    const appliedDiscount = !isOrder
        ? (organizer?.selected_discount ||
            (res.applied_discount_id && Array.isArray(res.discount_data_snapshot)
                ? res.discount_data_snapshot.find((d: any) => d.id === res.applied_discount_id)
                : null))
        : null;
    const discountPct = appliedDiscount && (appliedDiscount.percentage || appliedDiscount.discount_percentage);

    const statusLabel = getBusinessStatusLabel(res.status || 'PENDIENTE', kind);
    const code = res.unique_code || (res.id && res.id.slice(0, 8).toUpperCase()) || '---';
    const items: any[] = Array.isArray(res.items) ? res.items : [];

    return (
        <div className="w-full max-w-lg mx-auto">
            <div className="bg-card border border-border rounded-2xl shadow-lg overflow-hidden">

                {/* Cabecera: restaurante a la izquierda, código y estado a la derecha */}
                <div className={cn('bg-orange-500 text-white px-3 py-2.5 flex items-center justify-between gap-3', reserveCloseButton && 'pr-11')}>
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="w-7 h-7 shrink-0 rounded-lg bg-white/95 flex items-center justify-center">
                            {rest?.logo_url ? (
                                <img src={rest.logo_url} className="w-5 h-5 object-contain rounded" alt="Logo" />
                            ) : (
                                <Tag className="w-3.5 h-3.5 text-orange-500" />
                            )}
                        </div>
                        <div className="min-w-0">
                            <p className="text-[8px] uppercase font-extrabold tracking-widest text-white/80 leading-none">Restaurante</p>
                            <p className="font-extrabold text-sm leading-tight truncate">{rest?.name || 'Restaurante'}</p>
                        </div>
                    </div>
                    <div className="text-right shrink-0">
                        <p className="text-[8px] uppercase font-extrabold tracking-widest text-white/80 leading-none">
                            {isOrder ? 'Código de Pedido' : 'Código de Reserva'}
                        </p>
                        <p className="text-xl font-black tracking-wider leading-tight uppercase">{code}</p>
                        <span className={cn('inline-block mt-0.5 px-2 py-0.5 rounded-full border text-[9px] font-black uppercase tracking-wide', whiteStatusClasses(res.status || 'PENDIENTE'))}>
                            {statusLabel}
                        </span>
                    </div>
                </div>

                <div className="px-3 py-2.5 space-y-2.5">

                    {/* Seguimiento de estado, en línea */}
                    <div>
                        <p className={LBL}>Tracking de Estado</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            {timelineEvents.map((event, i) => (
                                <span key={i} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                    <span className={cn('w-2 h-2 rounded-full', i === timelineEvents.length - 1 ? 'bg-orange-500' : 'bg-border')} />
                                    <span className="font-extrabold uppercase">{event.label}</span>
                                    <span className="font-bold">{safeTime(event.date)}</span>
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Datos principales en rejilla de 2 columnas */}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        <div>
                            <p className={cn(LBL, 'flex items-center gap-1')}><Calendar className="w-3 h-3 text-orange-500" />{isOrder ? 'Pedido el' : 'Fecha'}</p>
                            <p className="text-[13px] font-extrabold mt-0.5">{format(date, 'eee d MMM', { locale: es })}</p>
                        </div>
                        <div>
                            <p className={cn(LBL, 'flex items-center gap-1')}><Clock className="w-3 h-3 text-orange-500" />{isOrder ? 'Hora de Retiro' : 'Hora'}</p>
                            <p className="text-[13px] font-extrabold mt-0.5">{isOrder && (res.pickup_time || metadata.pickup_time) ? (res.pickup_time || metadata.pickup_time) : format(date, 'HH:mm')}</p>
                        </div>
                        <div>
                            <p className={cn(LBL, 'flex items-center gap-1')}>
                                {isOrder ? <Tag className="w-3 h-3 text-orange-500" /> : <Users className="w-3 h-3 text-orange-500" />}
                                {isOrder ? 'Monto' : 'Personas'}
                            </p>
                            <p className="text-[13px] font-extrabold mt-0.5">
                                {isOrder ? formatCurrency(res.total_amount || 0) : `${res.party_size || guestList.length || 0} Personas`}
                            </p>
                        </div>
                        {restaurantPhone && (
                            <div>
                                <p className={cn(LBL, 'flex items-center gap-1')}><Phone className="w-3 h-3 text-orange-500" />Teléfono</p>
                                <a href={`tel:${restaurantPhone}`} className="text-[13px] font-extrabold mt-0.5 block hover:text-orange-500">{restaurantPhone}</a>
                            </div>
                        )}
                        <div className="col-span-2">
                            <p className={cn(LBL, 'flex items-center gap-1')}><MapPin className="w-3 h-3 text-orange-500" />Dirección</p>
                            <p className="text-[13px] font-extrabold mt-0.5">{restaurantAddress}</p>
                        </div>
                    </div>

                    {/* Comensal: organizador (reserva) o cliente (pedido) */}
                    {hasDiner && (
                        <div className="border-t border-border pt-2">
                            <p className={LBL}>{isOrder ? 'Cliente' : 'Organizador'}</p>
                            <div className="mt-1 flex items-start gap-2">
                                <span className="w-6 h-6 shrink-0 rounded-md bg-foreground text-background text-[9px] font-extrabold flex items-center justify-center">
                                    {getInitials(dinerName?.split(' ')[0], dinerName?.split(' ')[1])}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-[13px] font-extrabold leading-tight">
                                        {dinerName || 'Sin nombre'}
                                        {!isOrder && <span className="ml-1.5 align-middle text-[8px] bg-orange-500 text-white px-1.5 py-0.5 rounded font-extrabold uppercase">Host</span>}
                                    </p>
                                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground font-semibold">
                                        {dinerEmail && <span className="inline-flex items-center gap-1 break-all"><Mail className="w-3 h-3 shrink-0" />{dinerEmail}</span>}
                                        {dinerPhone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3 shrink-0" />{dinerPhone}</span>}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {paymentLabel && (
                        <div className="flex items-center gap-1.5 text-[12px]">
                            <CreditCard className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                            <span className={LBL}>Condición de Pago</span>
                            <span className="font-extrabold">{paymentLabel}</span>
                        </div>
                    )}

                    {appliedDiscount && (
                        <div className="flex items-start gap-1.5 rounded-lg bg-orange-50 border border-orange-200 px-2 py-1.5 text-orange-950 dark:bg-orange-950/50 dark:border-orange-900 dark:text-orange-50 dark:bg-orange-950/50 dark:border-orange-900 dark:text-orange-50">
                            <Percent className="w-3.5 h-3.5 text-orange-600 shrink-0 mt-0.5" />
                            <div className="min-w-0 leading-tight">
                                <p className="text-[9px] uppercase font-extrabold tracking-wider text-orange-700 dark:text-orange-300">Descuento Aplicado</p>
                                <p className="text-[12px] font-extrabold">
                                    {appliedDiscount.name || 'Descuento especial'}
                                    {discountPct && <span className="ml-1.5 text-orange-600">-{discountPct}%</span>}
                                </p>
                                {appliedDiscount.description && <p className="text-[10px] text-orange-800/70 dark:text-orange-200/80">{appliedDiscount.description}</p>}
                            </div>
                        </div>
                    )}

                    {specialNotes && (
                        <div className="flex items-start gap-1.5">
                            <StickyNote className="w-3.5 h-3.5 text-orange-500 shrink-0 mt-0.5" />
                            <div className="leading-tight">
                                <p className={LBL}>{isOrder ? 'Solicitudes Especiales' : 'Notas Especiales'}</p>
                                <p className="text-[12px] font-medium mt-0.5">{specialNotes}</p>
                            </div>
                        </div>
                    )}

                    {/* Productos (pedido o pre-pedido) con el total a pagar */}
                    {items.length > 0 && (
                        <div className="border-t border-border pt-2">
                            <div className="flex items-center justify-between">
                                <p className={LBL}>{isOrder ? 'Productos del Pedido' : 'Pre-pedidos de la Mesa'}</p>
                                <span className="bg-foreground text-background text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase">{items.length} TOTAL</span>
                            </div>
                            <ul className="mt-1 divide-y divide-border/60">
                                {items.map((item: any, i: number) => (
                                    <li key={i} className="flex items-center gap-2 py-1">
                                        <span className="w-6 h-6 shrink-0 rounded-md border border-border bg-background text-[11px] font-extrabold flex items-center justify-center">{item.quantity}</span>
                                        <span className="min-w-0 flex-1 leading-tight">
                                            <span className="block text-[12px] font-extrabold truncate">{item.name}</span>
                                            {Array.isArray(item.options) && item.options.length > 0 && (
                                                <span className="block text-[10px] leading-snug text-muted-foreground break-words">{item.options.map((o: any) => o.name).join(', ')}</span>
                                            )}
                                            <span className="block text-[9px] uppercase font-bold text-muted-foreground">P. Unitario: {formatCurrency(item.price)}</span>
                                        </span>
                                        <span className="text-[12px] font-extrabold">{formatCurrency(item.price * item.quantity)}</span>
                                    </li>
                                ))}
                            </ul>
                            <div className="mt-1 flex items-center justify-between rounded-lg bg-orange-50 border border-orange-200 px-2 py-1.5 text-orange-950 dark:bg-orange-950/50 dark:border-orange-900 dark:text-orange-50">
                                <span className="text-[10px] font-extrabold uppercase tracking-wider">Total a Pagar</span>
                                <span className="text-base font-black text-orange-600">{formatCurrency(res.total_amount || 0)}</span>
                            </div>
                        </div>
                    )}

                    {/* Invitados y asistencia (reservas) */}
                    {!isOrder && guestList.length > 0 && (
                        <div className="border-t border-border pt-2">
                            <div className="flex items-center justify-between">
                                <p className={LBL}>Invitados y Asistencia</p>
                                <span className="bg-foreground text-background text-[9px] font-extrabold px-2 py-0.5 rounded-full uppercase">{guestList.length} TOTAL</span>
                            </div>
                            <ul className="mt-1 space-y-1">
                                {guestList.map((guest: any, i: number) => {
                                    const name = guest.name || `${guest.firstName || ''} ${guest.lastName || ''}`.trim() || guest.email || 'Invitado';
                                    const status = guest.status || 'PENDIENTE';
                                    return (
                                        <li key={i} className="flex items-center gap-2">
                                            <span className={cn('w-6 h-6 shrink-0 rounded-md text-[9px] font-extrabold flex items-center justify-center',
                                                guest.is_organizer ? 'bg-foreground text-background' : 'bg-background text-muted-foreground border border-border')}>
                                                {getInitials(guest.firstName || guest.name?.split(' ')[0], guest.lastName || guest.name?.split(' ')[1])}
                                            </span>
                                            <span className="min-w-0 flex-1 leading-tight">
                                                <span className="block text-[12px] font-extrabold truncate">
                                                    {name}
                                                    {guest.is_organizer && <span className="ml-1.5 align-middle text-[8px] bg-orange-500 text-white px-1.5 py-0.5 rounded font-extrabold uppercase">Host</span>}
                                                </span>
                                                <span className="block text-[10px] text-muted-foreground font-semibold truncate">{guest.email || 'Invitado Digital'}</span>
                                            </span>
                                            <span className={cn('shrink-0 px-2 py-0.5 rounded-full border text-[9px] font-black uppercase tracking-tight', whiteStatusClasses(status))}>
                                                {getBusinessStatusLabel(status)}
                                            </span>
                                            {onInviteGuest && res.status === 'CONFIRMADA' && !guest.is_organizer && !guest.is_you && guest.id
                                                && status !== 'CONFIRMADA' && status !== 'RECHAZADA' && (
                                                <button type="button" onClick={() => onInviteGuest(guest)}
                                                    aria-label={`Enviar invitación a ${name}`}
                                                    className="shrink-0 w-7 h-7 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-orange-500 active:scale-90 transition-all">
                                                    <Send className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}

                    {extra}

                    {/* Acciones (solo con showActions) */}
                    {showActions && (
                        <div className="space-y-1.5">
                            <p className="text-[9px] font-black text-muted-foreground/60 uppercase tracking-widest text-center">Presenta este ticket al llegar</p>
                            {calendarLinks && (
                                <div className="grid grid-cols-2 gap-2">
                                    <a href={calendarLinks.google} target="_blank" rel="noopener noreferrer"
                                        className="flex items-center justify-center py-1.5 rounded-lg border border-border text-[10px] font-black uppercase tracking-wider hover:bg-orange-50 active:scale-95 transition-all">
                                        Google Calendar
                                    </a>
                                    <a href={calendarLinks.ics} download="reserva.ics"
                                        className="flex items-center justify-center py-1.5 rounded-lg border border-border text-[10px] font-black uppercase tracking-wider hover:bg-orange-50 active:scale-95 transition-all">
                                        Apple / ICS
                                    </a>
                                </div>
                            )}
                            {ticketUrl && res.unique_code && (
                                <a href={`${ticketUrl}/${isOrder ? 'o' : 'r'}/${res.unique_code}`}
                                    className="flex items-center justify-center gap-1 text-[9px] font-black text-muted-foreground/60 hover:text-orange-500 uppercase tracking-widest">
                                    <Ticket className="w-3 h-3" />
                                    Acceso Directo: tickets2.almuerzo.cl
                                </a>
                            )}
                        </div>
                    )}

                    {/* Notas de llegada / retiro */}
                    <div className="rounded-lg bg-orange-50/60 border border-orange-100 px-2 py-1.5 text-orange-950 dark:bg-orange-950/40 dark:border-orange-900 dark:text-orange-50">
                        <p className="text-[10px] font-extrabold">{isOrder ? 'Notas de retiro' : 'Notas de llegada'}</p>
                        <p className="text-[10px] text-orange-900/70 dark:text-orange-100/80 leading-snug">
                            {isOrder
                                ? 'Tu pedido estará listo en la hora indicada. Por favor retíralo pronto para disfrutarlo caliente.'
                                : 'Recuerda llegar puntual. Las mesas se liberan después de 15 minutos de retraso. Si no asistes, tu reputación bajará automáticamente.'}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
