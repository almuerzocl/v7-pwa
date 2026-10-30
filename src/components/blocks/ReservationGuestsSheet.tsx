'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Send, UserPlus, Loader2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import type { Contact } from '@/types';
import { useAuth } from '@/context/AuthContext';
import InviteesSelector from '@/components/blocks/InviteesSelector';
import { addReservationGuestsAction } from '@/app/actions/add-guests-action';
import { shareInvite } from '@/lib/share-invite';
import { TICKET_URL } from '@/lib/config';

const MAX_AT_ONCE = 10;

function guestsOf(res: any): any[] {
    const raw = res?.guest_data || res?.guests;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
}

/**
 * Invitados de una reserva, para su ORGANIZADOR: enviar a cada uno su enlace personal (WhatsApp / hoja de compartir)
 * y agregar invitados nuevos aunque la reserva ya esté creada. Agregar sigue el mismo camino del wizard
 * (acción de servidor + emisor de invitaciones); el cupo y la aprobación los decide la base.
 */
export default function ReservationGuestsSheet({ res, onClose, onChanged }: { res: any; onClose: () => void; onChanged: () => void }) {
    const { user } = useAuth();
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [selected, setSelected] = useState<Contact[]>([]);
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const list = useMemo(() => guestsOf(res), [res]);
    const organizer = list.find((g) => g.is_organizer);
    const others = list.filter((g) => !g.is_organizer);
    const confirmed = res.status === 'CONFIRMADA';

    const fetchContacts = async () => {
        if (!user) return;
        try {
            const r = await fetch(`/api/contacts?userId=${user.id}`);
            const j = await r.json();
            if (j.success && j.contacts) setContacts(j.contacts as Contact[]);
        } catch (e) { console.error('Error fetching contacts:', e); }
    };
    useEffect(() => { fetchContacts(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user?.id]);

    useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    const send = async (g: any) => {
        const result = await shareInvite({
            ticketBaseUrl: TICKET_URL, uniqueCode: res.unique_code, guestId: g.id, guestName: g.name,
            organizerName: organizer?.name, restaurantName: res.restaurant?.name, dateTime: res.date_time,
        });
        if (result === 'copied') toast.success('Invitación copiada. Pégala en WhatsApp o donde prefieras.');
        else if (result === 'failed') toast.error('No se pudo compartir la invitación');
    };

    const add = async () => {
        if (selected.length === 0) return;
        setSaving(true);
        setNotice(null);
        try {
            const r = await addReservationGuestsAction(res.id, selected.map((c) => ({
                id: c.id,
                name: `${c.first_name || 'Invitado'} ${c.last_name || ''}`.trim(),
                email: c.email || null,
                phone: c.whatsapp_phone || null,
            })));
            if (!r.success) { toast.error(r.error); return; }
            setSelected([]);
            if (r.needsApproval) {
                setNotice(`Tu reserva pasó de ${r.previousPartySize} a ${r.partySize} personas y quedó sujeta a aprobación del restaurante. ` +
                    `${r.noticeSent === false ? 'No pudimos enviarte el correo de aviso. ' : 'Te enviamos un correo. '}Tus invitados nuevos recibirán su invitación cuando se confirme.`);
            } else {
                toast.success(`${selected.length} invitado${selected.length > 1 ? 's' : ''} agregado${selected.length > 1 ? 's' : ''}`);
            }
            onChanged();
        } catch (e) {
            console.error('addReservationGuests', e);
            toast.error('No se pudo agregar a los invitados');
        } finally { setSaving(false); }
    };

    return (
        <div className="fixed inset-0 z-[9000] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
            <div className="relative bg-background w-full max-w-md max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-5 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <button onClick={onClose} aria-label="Cerrar" className="absolute top-3 right-3 rounded-full p-1.5 border border-border/50 hover:bg-muted"><X className="w-4 h-4" /></button>
                <div>
                    <h2 className="font-black text-base">Invitados</h2>
                    <p className="text-xs text-muted-foreground">{res.restaurant?.name || 'Reserva'} · {res.party_size || list.length} personas</p>
                </div>

                {notice && <p className="text-xs font-semibold rounded-xl bg-amber-50 border border-amber-200 text-amber-900 p-3">{notice}</p>}
                {!confirmed && !notice && (
                    <p className="text-xs text-muted-foreground rounded-xl bg-muted/50 p-3">
                        Tu reserva aún no está confirmada. Los invitados recibirán su invitación cuando el restaurante la confirme.
                    </p>
                )}

                {others.length > 0 && (
                    <ul className="space-y-2">
                        {others.map((g, i) => {
                            const status = g.status || 'PENDIENTE';
                            const canSend = confirmed && g.id && status !== 'CONFIRMADA' && status !== 'RECHAZADA';
                            return (
                                <li key={g.id || i} className="flex items-center gap-2 rounded-xl border border-border/50 p-2.5">
                                    <span className="min-w-0 flex-1 leading-tight">
                                        <span className="block text-sm font-bold truncate">{g.name || 'Invitado'}</span>
                                        <span className="block text-xs text-muted-foreground truncate">{g.email || g.phone || 'Sin contacto'}</span>
                                    </span>
                                    <span className="text-xs font-black uppercase text-muted-foreground">{status}</span>
                                    {canSend && (
                                        <button type="button" onClick={() => send(g)} aria-label={`Enviar invitación a ${g.name}`}
                                            className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center active:scale-90">
                                            <Send className="w-4 h-4" />
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {confirmed && others.length > 0 && (
                    <p className="text-xs text-muted-foreground">El enlace es personal: envíalo a cada invitado por separado, no a un grupo.</p>
                )}

                <div className="border-t border-border pt-4 space-y-3">
                    <p className="text-sm font-bold flex items-center gap-1.5"><UserPlus className="w-4 h-4" /> Agregar invitados</p>
                    <InviteesSelector
                        contacts={contacts}
                        selected={selected}
                        onAddInvitee={(c) => setSelected((prev) => (prev.length >= MAX_AT_ONCE || prev.find((x) => x.id === c.id)) ? prev : [...prev, c])}
                        onRemoveInvitee={(id) => setSelected((prev) => prev.filter((c) => c.id !== id))}
                        onContactSaved={fetchContacts}
                    />
                    <button type="button" onClick={add} disabled={saving || selected.length === 0}
                        className="w-full h-11 rounded-xl bg-foreground text-background font-black text-xs uppercase tracking-widest disabled:opacity-40 flex items-center justify-center gap-2">
                        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                        {selected.length > 0 ? `Agregar ${selected.length} a la reserva` : 'Elige a quién agregar'}
                    </button>
                </div>
            </div>
        </div>
    );
}
