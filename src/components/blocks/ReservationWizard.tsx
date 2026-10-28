'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { format, isSameDay, startOfToday } from 'date-fns';
import { es } from 'date-fns/locale';
import { fromZonedTime } from 'date-fns-tz';
import {
    Clock,
    Calendar,
    Users,
    CreditCard,
    CheckCircle,
    X,
    ChevronRight,
    MapPin,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TicketDigital } from '@/components/TicketDigital';
import { toast } from 'react-hot-toast';
import DateTimePicker from './DateTimePicker';
import InviteesSelector from './InviteesSelector';
import ShareReservationModal from './ShareReservationModal';
import { useAuth } from '@/context/AuthContext';

import { supabase } from '@/lib/supabase';
import { notifyRestaurantAdmin } from '@/lib/notifications';
import type { Contact } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { TICKET_URL, TIMEZONE } from '@/lib/config';
import { trackReservationStart, trackReservationConfirm } from '@/lib/ga4';
import { trackClientEvent } from '@/lib/client-events';
import { trackPlatformEvent, trackFailure } from '@/lib/platform-events';
import { getRestaurantDailyAvailabilityAction } from '@/app/actions/reservation-actions';
import { saveContactAction } from '@/app/actions/contacts-actions';
import { OperationUsage } from '@/components/OperationUsage';
import { createReservationAction } from '@/app/actions/reservation-create-action';
import { checkCapacity, loadEligibleDiscounts, matchExistingUser, type InstitutionDiscount } from '@/lib/core-business';
import { DiscountPicker } from '@/components/blocks/DiscountPicker';
import { CheckoutEngine } from '@/lib/core-business/checkout-engine';
import { BlockingToast } from './BlockingToast';

interface ReservationWizardProps {
    restaurantId: string;
    restaurantName: string;
    onClose: () => void;
    slotDuration?: number;
    address?: string;
}

type Step = 'form' | 'confirmation';

function translateRRule(rule: string | null): string {
    if (!rule) return '';
    let text = 'Personalizado';
    if (rule.includes('FREQ=WEEKLY')) text = 'Semanalmente';
    if (rule.includes('FREQ=MONTHLY')) text = 'Mensualmente';
    if (rule.includes('FREQ=DAILY')) text = 'Diariamente';
    const days: Record<string, string> = {
        'MO': 'Lunes', 'TU': 'Martes', 'WE': 'Miércoles', 'TH': 'Jueves',
        'FR': 'Viernes', 'SA': 'Sábado', 'SU': 'Domingo'
    };
    const byDayMatch = rule.match(/BYDAY=([A-Z,]+)/) || rule.match(/BYWEEKDAY=([A-Z,]+)/);
    if (byDayMatch) {
        const dayNames = byDayMatch[1].split(',').map(d => days[d] || d).filter(Boolean);
        if (dayNames.length > 0) text += ` los ${dayNames.join(', ')}`;
    }
    return text;
}

export default function ReservationWizard({
    restaurantId,
    restaurantName,
    onClose,
    address,
    slotDuration
}: ReservationWizardProps) {
    const { user, profile } = useAuth();
    const [mounted, setMounted] = useState(false);
    const [step, setStep] = useState<Step>('form');
    const [date, setDate] = useState<Date | undefined>(startOfToday());
    const [time, setTime] = useState<string | undefined>(undefined);
    const [reservationCode, setReservationCode] = useState<string>('');

    const [contacts, setContacts] = useState<Contact[]>([]);
    const [selectedInvitees, setSelectedInvitees] = useState<Contact[]>([]);

    const guests = selectedInvitees.length + 1;
    const [notes, setNotes] = useState('');
    const [loading, setLoading] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [isConfirmed, setIsConfirmed] = useState(false);
    const [showTerms, setShowTerms] = useState(false);

    const [shareToken, setShareToken] = useState<string>('');
    const [createdReservationId, setCreatedReservationId] = useState<string>('');

    const [recurrenceRule] = useState<string | null>(null);
    const [userPhone, setUserPhone] = useState('');
    const [paymentMethod, setPaymentMethod] = useState<string>('individual');

    const [institutionDiscounts, setInstitutionDiscounts] = useState<InstitutionDiscount[]>([]);
    const [discountsUnavailable, setDiscountsUnavailable] = useState(false);
    // Elección del cliente (uno o ninguno), antes de enviar; solo cuenta si aceptó el aviso
    const [selectedDiscount, setSelectedDiscount] = useState<InstitutionDiscount | null>(null);
    const [discountAccepted, setDiscountAccepted] = useState(false);
    const [availability, setAvailability] = useState<any[] | undefined>(undefined);
    // El local atiende ese día pero su ventana de reservas no deja reservar (distinto de «cerrado»).
    const [noReservations, setNoReservations] = useState(false);
    // Cache discounts per date string so changing guests doesn't re-fetch them (las fallas no se cachean)
    const discountCacheRef = useRef<Map<string, InstitutionDiscount[]>>(new Map());
    const [toastConfig, setToastConfig] = useState<{ isOpen: boolean; title: string; message: string; type: 'success' | 'loading' | 'error' }>({
        isOpen: false, title: '', message: '', type: 'loading'
    });

    useEffect(() => {
        setMounted(true);
        trackReservationStart(restaurantId, restaurantName);
        trackClientEvent('reservation_start', restaurantId, { surface: 'wizard' });
    }, []);

    // Pasos del asistente (formulario -> confirmación): una vez por sesión y local.
    useEffect(() => {
        trackPlatformEvent('checkout_step', { restaurantId, step: step, props: { kind: 'reservation' }, once: true });
    }, [step, restaurantId]);

    // Load draft on mount

    // Fetch contacts + phone
    useEffect(() => {
        if (user) fetchContacts();
        if (profile) {
            setUserPhone(profile.phone_number || profile.phone || user?.phone || user?.user_metadata?.phone || user?.user_metadata?.phone_number || '');
        } else if (user?.phone || user?.user_metadata?.phone) {
            setUserPhone(user?.phone || user?.user_metadata?.phone || '');
        }
    }, [user, profile]);

    // Availability re-fetches when date or guests change (slots depend on both)
    useEffect(() => {
        if (!mounted || !restaurantId || !date) return;
        const id = setTimeout(() => fetchAvailability(), 400);
        return () => clearTimeout(id);
    }, [restaurantId, date, guests, mounted]);

    // Discounts only depend on date (not guests) — cache per date to avoid repeated calls
    useEffect(() => {
        if (!mounted || !restaurantId || !date || !user?.id) return;
        const dateStr = format(date, 'yyyy-MM-dd');
        if (discountCacheRef.current.has(dateStr)) {
            // Already fetched for this date — apply from cache immediately
            applyDiscountResults(discountCacheRef.current.get(dateStr)!);
            return;
        }
        const id = setTimeout(() => fetchDiscounts(dateStr), 400);
        return () => clearTimeout(id);
    }, [restaurantId, date, mounted, user?.id]);

    const fetchAvailability = async () => {
        if (!date) return;
        const dateStr = format(date, 'yyyy-MM-dd');
        try {
            const res = await Promise.race([
                getRestaurantDailyAvailabilityAction(restaurantId, dateStr, guests),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('availability-timeout')), 12000)
                ),
            ]);
            if (res.success) { setAvailability(res.data || []); setNoReservations(!!res.noReservations); }
            else { console.error("[Wizard] Availability error:", res.error); setAvailability([]); setNoReservations(false); }
        } catch (err) {
            console.error("[Wizard] Availability fetch failed:", err);
            setAvailability([]);
        }
    };

    const fetchDiscounts = async (dateStr: string) => {
        if (!user?.id || !date) return;
        // Nunca lanza: si el servicio de descuentos no responde, se sigue sin descuentos y se avisa.
        const { discounts, unavailable } = await loadEligibleDiscounts(restaurantId, 'reservation', dateStr);
        if (unavailable) {
            applyDiscountResults([], true);
        } else {
            discountCacheRef.current.set(dateStr, discounts);
            applyDiscountResults(discounts, false);
        }
    };

    const applyDiscountResults = (data: InstitutionDiscount[], unavailable = false) => {
        setInstitutionDiscounts(data);
        setDiscountsUnavailable(unavailable);
        // La elección anterior pudo dejar de aplicar al cambiar de fecha
        setSelectedDiscount(prev => (prev && data.some(d => d.discount_id === prev.discount_id) ? prev : null));
    };

    const fetchContacts = async () => {
        if (!user) return;
        try {
            const res = await fetch(`/api/contacts?userId=${user.id}`);
            const result = await res.json();
            if (result.success && result.contacts) setContacts(result.contacts as any);
            else console.error("Error fetching contacts:", result.error);
        } catch (err) {
            console.error("Error fetching contacts:", err);
        }
    };

    // InviteesSelector already persists new contacts (agenda picker or manual
    // form) to the contacts table before calling this, so `contact` always
    // carries a real id here — just add it to this reservation's invitee list.
    const handleAddInvitee = (contact: Contact) => {
        setSelectedInvitees(prev => prev.find(i => i.id === contact.id) ? prev : [...prev, contact]);
    };

    const handleDateSelect = (selectedDate: Date, selectedTime: string) => {
        setDate(selectedDate);
        setTime(selectedTime);
        setAvailability(undefined); // reset slots skeleton
        // Solo si cambió el día: el efecto de descuentos depende de `date` y no se re-ejecuta si el
        // día es el mismo (al elegir la hora llega el mismo Date), así que borrarlos aquí los perdería.
        if (!date || !isSameDay(selectedDate, date)) {
            setInstitutionDiscounts([]);
            setSelectedDiscount(null);
            setDiscountAccepted(false);
        }
    };

    const checkAvailability = async (checkDate?: Date, checkTime?: string) => {
        const targetDate = checkDate || date;
        const targetTime = checkTime || time;
        if (!targetDate || !targetTime) return true;
        setLoading(true);
        try {
            const result = await Promise.race([
                checkCapacity(restaurantId, targetDate, targetTime, guests, 'reservation'),
                new Promise<{ isAvailable: true; remainingSeats: 0 }>((resolve) =>
                    setTimeout(() => resolve({ isAvailable: true, remainingSeats: 0 }), 8000)
                ),
            ]);
            if (!result.isAvailable) {
                toast.error(`Lo sentimos, el restaurante está lleno. Espacios: ${result.remainingSeats || 0}`);
                return false;
            }
            return true;
        } catch (err: any) {
            console.warn('[Business Logic] Capacity check skipped:', err.message);
            return true;
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async () => {
        if (!date || !time) {
            toast.error('Por favor selecciona fecha y hora');
            return;
        }
        const isAvailable = await checkAvailability(date, time);
        if (!isAvailable) return;

        // El cliente ya eligió (o no) en el selector de descuentos; solo cuenta si aceptó el aviso.
        // El servidor revalida la vigencia justo antes de crear la reserva.
        if (selectedDiscount && !discountAccepted) {
            toast.error('Confirma el aviso del descuento con "OK, Entendido" o elige "No quiero descuento"');
            return;
        }
        const appliedDiscount = selectedDiscount && discountAccepted ? selectedDiscount : null;

        setLoading(true);
        try {
            // Race the entire reservation flow against a 60-second safety net.
            // This ensures the BlockingToast loading overlay can never get stuck forever.
            await Promise.race([
                handleSubmitReservation(appliedDiscount),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('La reserva tardó demasiado. Por favor, intenta de nuevo.')), 60000)
                ),
            ]);
        } catch (err: any) {
            console.error("Critical wizard failure:", err);
            setToastConfig({
                isOpen: true,
                title: 'Error Inesperado',
                message: err?.message || 'Ocurrió un error inesperado. Por favor, intenta de nuevo.',
                type: 'error'
            });
        } finally {
            setLoading(false);
        }
    };

    const handleSubmitReservation = async (appliedDiscount: InstitutionDiscount | null = null) => {
        if (!profile || !user) {
            toast.error("Debes iniciar sesión para reservar");
            return;
        }

        trackPlatformEvent('checkout_start', { restaurantId, props: { kind: 'reservation' } });
        setLoading(true);
        setToastConfig({ isOpen: true, title: 'Procesando Reserva', message: 'Estamos confirmando tu reserva con el restaurante...', type: 'loading' });

        try {
            const safeProfile = CheckoutEngine.getSafeProfile(user, profile);

            if (!date || !time) {
                setToastConfig({ isOpen: true, title: 'Error de Validación', message: 'Falta seleccionar fecha u hora.', type: 'error' });
                return;
            }

            const dailyReputation = await CheckoutEngine.calculateDailyReputation(user.id, 'reservation');
            const benefits = CheckoutEngine.applyAccountBenefits({ user: safeProfile, restaurantId });

            const resDateStr = format(date, 'yyyy-MM-dd');
            const resTimeStr = `${resDateStr} ${time}:00`;
            const reservationDate = fromZonedTime(resTimeStr, TIMEZONE);

            const sessionInfo = CheckoutEngine.prepareSessionData(safeProfile);
            const organizerName = sessionInfo.fullName || user?.email || 'Usuario';
            const organizerEmail = sessionInfo.email;

            setToastConfig(prev => ({ ...prev, message: 'Preparando lista de invitados...' }));

            const guestsList = await Promise.all([
                Promise.resolve({
                    id: uuidv4(),
                    name: organizerName,
                    email: organizerEmail,
                    phone: sessionInfo.contactPhone,
                    is_organizer: true,
                    status: 'CONFIRMADA',
                    notes: notes,
                    selected_discount: appliedDiscount ? {
                        id: appliedDiscount.discount_id,
                        name: `${appliedDiscount.institution_name} - ${appliedDiscount.discount_name}`,
                        percentage: appliedDiscount.amount_type === 'percent' ? appliedDiscount.amount : 0
                    } : null
                }),
                ...(selectedInvitees || []).map(async (inv) => {
                    let contactId = inv.id;
                    if (contactId?.startsWith('tmp-')) {
                        try {
                            const result = await saveContactAction(user.id, {
                                first_name: inv.first_name || 'Invitado',
                                last_name: inv.last_name || '',
                                email: inv.email || null,
                                whatsapp_phone: inv.whatsapp_phone || null
                            });
                            if (result.success && result.contact) contactId = result.contact.id;
                        } catch (err) {
                            console.error("Delayed contact persistence failed:", err);
                        }
                    }
                    const linkedUserId = await Promise.race([
                        matchExistingUser(inv.email, inv.whatsapp_phone),
                        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
                    ]).catch(() => null);
                    return {
                        id: contactId || uuidv4(),
                        name: `${inv.first_name || 'Invitado'} ${inv.last_name || ''}`.trim(),
                        email: inv.email || null,
                        phone: inv.whatsapp_phone || null,
                        is_organizer: false,
                        status: 'PENDIENTE',
                        user_id: linkedUserId || null
                    };
                })
            ]);

            setToastConfig(prev => ({ ...prev, message: 'Confirmando disponibilidad final...' }));

            const reservationUniqueCode = uuidv4().split('-')[0].toUpperCase();
            setToastConfig(prev => ({ ...prev, message: 'Creando registro de reserva...' }));

            // La observación del descuento la agrega el servidor solo si el descuento sigue vigente
            const finalNotes = notes;

            const createResult = await createReservationAction({
                restaurant_id: restaurantId,
                organizer_id: user.id,
                date_time: reservationDate.toISOString(),
                status: 'PENDIENTE',
                payment_method: paymentMethod,
                title: `Reserva de ${organizerName}`,
                guest_ids: (selectedInvitees || []).map(c => c.id).filter(id => id && !id.startsWith('tmp-')),
                guest_data: guestsList,
                guests: guestsList,
                party_size: guestsList.length,
                organizer_reputation_snapshot: dailyReputation.score,
                user_total_reservations_snapshot: safeProfile.total_reservations ?? 0,
                discount_data_snapshot: institutionDiscounts,
                applied_discount_id: appliedDiscount?.discount_id ?? null, // el servidor lo revalida
                account_type_snapshot: safeProfile.account_type,
                benefits_snapshot: benefits,
                special_requests: finalNotes,
                unique_code: reservationUniqueCode,
                timestamps: {
                    'SOLICITADA': { at: new Date().toISOString() },
                    'PENDIENTE': { at: new Date().toISOString() }
                }
            });

            const reservation = createResult.reservation;
            if ('discountDropped' in createResult && createResult.discountDropped) {
                toast(createResult.discountDropped.message, { duration: 8000 });
            }
            const error = createResult.success ? null : createResult.error;

            if (!createResult.success && 'limitReached' in createResult) {
                // Tope de operaciones por día/semana (lo decide la base). El mensaje ya viene en español y sin error crudo.
                setToastConfig({ isOpen: true, title: 'Llegaste a tu límite', message: createResult.error ?? '', type: 'error' });
                return;
            }

            if (!createResult.success || !reservation) {
                console.error('[ReservationWizard] Insert error:', error);
                // If the DB atomic function rejected due to capacity, show a friendly message
                const isFull = error?.includes('Sin cupo');
                const remaining = (createResult as any).remainingSeats ?? 0;
                const message = isFull
                    ? `Lo sentimos, el restaurante está lleno para ese horario. Espacios disponibles: ${remaining}`
                    : (error || 'Hubo un error al guardar la reserva. Intenta de nuevo.');
                setToastConfig({ isOpen: true, title: isFull ? 'Sin cupo disponible' : 'Error al Reservar', message, type: 'error' });
                return;
            }

            // Close the blocking overlay immediately so the confirmation step is visible right away
            setToastConfig(prev => ({ ...prev, isOpen: false }));

            if (reservation) {
                setReservationCode(reservation.unique_code);
                setShareToken(reservation.unique_code);
                setCreatedReservationId(reservation.id);

                // Correos: NO se envían desde aquí. El correo de confirmación y las invitaciones los envía el
                // servidor solo cuando la reserva queda CONFIRMADA (src/lib/server/reservation-confirmation.ts).
                // Lo que sí sale al crear es el aviso interno al restaurante, para que pueda aprobar.
                notifyRestaurantAdmin({
                    id: reservation.id,
                    uniqueCode: reservation.unique_code,
                    restaurantId,
                    restaurantName,
                    dateTime: reservationDate.toISOString(),
                    partySize: guests,
                    guestName: organizerName,
                    guestEmail: organizerEmail,
                    guestPhone: sessionInfo.contactPhone,
                    type: 'reservation',
                    guests: guestsList,
                }).catch(console.error);

                const confirmedNow = !!(createResult as any).autoApproved;
                setIsConfirmed(confirmedNow);

                if (confirmedNow) {
                    toast.success('¡Reserva confirmada!', {
                        duration: 3000,
                        style: { borderRadius: '1rem', background: '#333', color: '#fff', fontWeight: 700 }
                    });
                } else {
                    toast.success('Solicitud enviada', {
                        duration: 4000,
                        style: { borderRadius: '1rem', background: '#333', color: '#fff', fontWeight: 700 }
                    });
                }

                trackReservationConfirm(restaurantId, restaurantName, guests);
                trackPlatformEvent('checkout_submit', { restaurantId, refId: reservation.id, discountId: appliedDiscount?.discount_id, step: confirmedNow ? 'confirmed' : 'pending', props: { kind: 'reservation', result: 'ok' } });
                setStep('confirmation');
            }

        } catch (err: any) {
            console.error('Error creating reservation:', err);
            trackFailure('checkout_error', err, { restaurantId, props: { kind: 'reservation' } });
            let errorMessage = 'No pudimos procesar tu reserva. ';
            if (err.message) errorMessage += `Mensaje: ${err.message}. `;
            if (err.code) errorMessage += `Código: ${err.code}. `;
            if (err.details) errorMessage += `Detalles: ${err.details}. `;
            if (err.hint) errorMessage += `Sugerencia: ${err.hint}. `;
            setToastConfig({
                isOpen: true,
                title: 'Error en la Reserva',
                message: errorMessage.trim() || 'Error desconocido al procesar la reserva.',
                type: 'error'
            });
        } finally {
            setLoading(false);
        }
    };

    if (!mounted) return null;

    return (
    <>
    {createPortal(
        <div className="fixed inset-0 z-[30000] flex items-end sm:items-center justify-center sm:p-4 bg-background/80 backdrop-blur-md pt-[env(safe-area-inset-top)]">
            <motion.div
                initial={{ opacity: 0, y: 50, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 50, scale: 0.95 }}
                className="bg-card w-full max-w-lg sm:rounded-[2rem] rounded-t-[2rem] shadow-2xl ring-1 ring-border/50 overflow-hidden flex flex-col max-h-[95vh] sm:max-h-[90vh]"
            >
                {/* Header */}
                <div className="px-5 py-4 border-b border-border/50 flex justify-between items-center bg-muted/30 sticky top-0 z-10 backdrop-blur-lg shrink-0">
                    <div>
                        <h2 className="font-extrabold text-lg text-foreground tracking-tight">Reservar Sillas</h2>
                        <p className="text-[11px] text-muted-foreground font-medium flex items-center gap-1 mt-0.5">
                            <MapPin className="w-3 h-3 text-primary" /> {restaurantName}
                        </p>
                    </div>
                    <button onClick={onClose} className="p-2 bg-background hover:bg-muted border border-border shadow-sm rounded-full transition-colors text-muted-foreground hover:text-foreground">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* ── FORM ── */}
                {step === 'form' && (
                    <>
                        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

                            {/* 1. Fecha y Hora */}
                            <section className="space-y-2">
                                <h3 className="font-bold text-sm text-foreground tracking-tight flex items-center gap-2">
                                    <Calendar className="w-4 h-4 text-primary" /> Fecha y Hora
                                </h3>
                                <DateTimePicker
                                    onSelect={handleDateSelect}
                                    selectedDate={date}
                                    selectedTime={time}
                                    availability={availability}
                                    noReservations={noReservations}
                                />
                            </section>

                            {/* 2. Invitados */}
                            <section className="space-y-2">
                                <h3 className="font-bold text-sm text-foreground tracking-tight flex items-center gap-2">
                                    <Users className="w-4 h-4 text-primary" /> Invitados
                                    <span className="ml-auto text-[11px] font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                                        {guests} {guests === 1 ? 'persona' : 'personas'}
                                    </span>
                                </h3>
                                <InviteesSelector
                                    contacts={contacts}
                                    selected={selectedInvitees}
                                    onAddInvitee={handleAddInvitee}
                                    onRemoveInvitee={(id) => setSelectedInvitees(p => p.filter(c => c.id !== id))}
                                    onContactSaved={fetchContacts}
                                />
                            </section>

                            {/* 3. Método de pago */}
                            <section className="space-y-2">
                                <h3 className="font-bold text-sm text-foreground tracking-tight flex items-center gap-2">
                                    <CreditCard className="w-4 h-4 text-primary" /> ¿Quién paga?
                                </h3>
                                <div className="relative">
                                    <select
                                        value={paymentMethod}
                                        onChange={(e) => setPaymentMethod(e.target.value)}
                                        className="w-full p-4 border border-border rounded-2xl focus:ring-2 focus:ring-primary/50 outline-none bg-muted/30 hover:bg-muted/50 font-semibold text-foreground appearance-none cursor-pointer transition-colors"
                                    >
                                        <option value="individual">Cada uno paga lo suyo</option>
                                        <option value="organizer">Yo invito (La casa invita)</option>
                                        <option value="fixed">Monto fijo / Cuota por persona</option>
                                    </select>
                                    <ChevronRight className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground rotate-90 pointer-events-none" />
                                </div>
                            </section>

                            {/* 4. Notas */}
                            <section className="space-y-2">
                                <h3 className="font-bold text-sm text-foreground tracking-tight">Notas especiales <span className="font-normal text-muted-foreground">(opcional)</span></h3>
                                <textarea
                                    value={notes}
                                    onChange={(e) => setNotes(e.target.value)}
                                    rows={3}
                                    className="w-full p-4 border border-border rounded-2xl focus:ring-2 focus:ring-primary/50 outline-none resize-none bg-muted/30 text-foreground placeholder:text-muted-foreground transition-all focus:bg-background text-sm"
                                    placeholder="Alergias, silla de bebé, ocasión especial..."
                                />
                            </section>

                        </div>

                        {/* Footer: resumen inline + botón */}
                        <div className="shrink-0 border-t border-border/50 bg-background/80 backdrop-blur-md px-5 pt-3 pb-5 space-y-3" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom, 1.25rem))' }}>

                            {/* Resumen compacto */}
                            {(date || time || guests > 1) && (
                                <div className="flex items-center gap-3 text-[11px] text-muted-foreground font-medium flex-wrap">
                                    {date && (
                                        <span className="flex items-center gap-1 bg-muted px-2 py-1 rounded-lg">
                                            <Calendar className="w-3 h-3" />
                                            {format(date, "eee d MMM", { locale: es })}
                                        </span>
                                    )}
                                    {time && (
                                        <span className="flex items-center gap-1 bg-muted px-2 py-1 rounded-lg">
                                            <Clock className="w-3 h-3" />
                                            {time}
                                        </span>
                                    )}
                                    <span className="flex items-center gap-1 bg-muted px-2 py-1 rounded-lg">
                                        <Users className="w-3 h-3" />
                                        {guests} {guests === 1 ? 'persona' : 'personas'}
                                    </span>
                                    <button type="button" onClick={() => setShowTerms(true)} className="ml-auto text-primary underline underline-offset-2">
                                        Condiciones
                                    </button>
                                </div>
                            )}

                            <DiscountPicker
                                serviceLabel="reserva"
                                discounts={institutionDiscounts}
                                unavailable={discountsUnavailable}
                                selected={selectedDiscount}
                                accepted={discountAccepted}
                                onSelect={(d) => { setSelectedDiscount(d); setDiscountAccepted(false); }}
                                onAccept={() => setDiscountAccepted(true)}
                            />

                            <OperationUsage variant="inline" />
                            <button
                                onClick={handleSubmit}
                                disabled={loading}
                                className="w-full h-14 bg-primary text-primary-foreground rounded-2xl font-bold text-base hover:bg-primary/90 transition-all disabled:opacity-50 active:scale-[0.98] shadow-md shadow-primary/20"
                            >
                                {loading ? (
                                    <span className="flex items-center justify-center gap-2">
                                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        Procesando...
                                    </span>
                                ) : 'Confirmar Reserva'}
                            </button>
                        </div>
                    </>
                )}

                {/* ── CONFIRMACIÓN ── */}
                {step === 'confirmation' && (
                    <motion.div
                        key="confirmation"
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        className="flex-1 overflow-y-auto p-5 space-y-6"
                    >
                        <div className="sticky top-0 z-10 -mt-2 flex justify-end">
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Cerrar"
                                className="p-2.5 bg-background hover:bg-muted border border-border shadow-md rounded-full transition-colors text-foreground"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="text-center space-y-2 -mt-6">
                            <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                                <CheckCircle className="w-8 h-8 text-green-500" />
                            </div>
                            <h3 className="text-2xl font-black text-foreground tracking-tight">
                                {isConfirmed ? '¡Reserva Confirmada!' : 'Solicitud enviada'}
                            </h3>
                            <p className="text-sm text-muted-foreground font-medium">
                                {isConfirmed
                                    ? `Tu lugar en ${restaurantName} está asegurado.`
                                    : 'Te avisaremos cuando el restaurante la confirme.'}
                            </p>
                        </div>

                        <div className="scale-90 origin-top">
                            <TicketDigital
                                res={{
                                    unique_code: reservationCode,
                                    status: isConfirmed ? 'CONFIRMADA' : 'PENDIENTE',
                                    date_time: (date && time) ? new Date(new Date(date).setHours(parseInt(time.split(':')[0]), parseInt(time.split(':')[1]))).toISOString() : new Date().toISOString(),
                                    party_size: guests,
                                    restaurant: { name: restaurantName, logo_url: '', address: address || '' },
                                    guest_data: [],
                                    timestamps: { 'SOLICITADA': { at: new Date().toISOString() } }
                                }}
                                showActions={false}
                            />
                        </div>

                        <div className="space-y-3 pb-4">
                            <Button onClick={onClose}
                                className="w-full h-14 rounded-2xl font-bold text-lg shadow-lg shadow-primary/20 active:scale-95">
                                Seguir Navegando
                            </Button>
                        </div>
                    </motion.div>
                )}

                {/* Terms modal */}
                {showTerms && (
                    <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-6 animate-in fade-in duration-200" onClick={() => setShowTerms(false)}>
                        <div className="bg-card rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4 animate-in zoom-in-95 duration-200 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                            <div className="flex items-center justify-between">
                                <h3 className="font-black text-lg text-foreground">Reglas y Condiciones</h3>
                                <button onClick={() => setShowTerms(false)} className="p-2 rounded-full hover:bg-muted transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <div className="text-sm text-muted-foreground leading-relaxed space-y-3">
                                <p>Al confirmar esta reservación, usted acepta las siguientes condiciones del servicio de reservas de Almuerzo.cl:</p>
                                <p>1. La reserva queda sujeta a disponibilidad y confirmación del restaurante. Las reservas auto-confirmadas dependen de su nivel de reputación en la plataforma.</p>
                                <p>2. Usted puede cancelar su reserva en cualquier momento. Si la cancelación se realiza con más de una hora de anticipación, no habrá impacto en su reputación. Si cancela con menos de una hora de anticipación, esto se registrará como un punto negativo en su reputación.</p>
                                <p>3. En caso de no presentarse a su reserva (no-show), su reputación se verá afectada negativamente, lo que puede limitar funcionalidades como la auto-confirmación de futuras reservas.</p>
                                <p>4. El restaurante se reserva el derecho de liberar la mesa después de 15 minutos de retraso sin aviso previo. Se recomienda llegar puntualmente a la hora indicada.</p>
                                <p>5. Los descuentos aplicados son válidos únicamente para la reserva en la que fueron seleccionados y están sujetos a las condiciones establecidas por cada restaurante.</p>
                                <p>6. Al utilizar esta plataforma, usted acepta nuestra política de privacidad y el tratamiento de sus datos personales conforme a la legislación vigente.</p>
                            </div>
                            <Button onClick={() => setShowTerms(false)} className="w-full rounded-xl h-12 font-bold">Entendido</Button>
                        </div>
                    </div>
                )}

                {shareOpen && (
                    <ShareReservationModal
                        reservation={{
                            id: createdReservationId || '',
                            restaurant_name: restaurantName,
                            reservation_date: date ? date.toISOString() : '',
                            party_size: guests,
                            share_token: shareToken,
                            code: reservationCode || '',
                            address: address,
                            durationMinutes: slotDuration || 90
                        }}
                        onClose={() => setShareOpen(false)}
                    />
                )}
            </motion.div>

            <BlockingToast
                isOpen={toastConfig.isOpen}
                title={toastConfig.title}
                message={toastConfig.message}
                type={toastConfig.type}
                onClose={() => setToastConfig(prev => ({ ...prev, isOpen: false }))}
            />
        </div>,
        document.body
    )}

    </>
  );
}
