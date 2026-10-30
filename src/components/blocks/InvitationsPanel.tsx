'use client';

import { useState } from 'react';
import { Copy, MessageCircle, Share2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { TICKET_URL } from '@/lib/config';
import { copyInviteLink, inviteMessageText, openWhatsApp, shareInvite, type InviteInput } from '@/lib/share-invite';

export function guestsOf(res: any): any[] {
    const raw = res?.guest_data || res?.guests;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
}

type Reply = 'confirmed' | 'declined' | 'unsure' | 'none';
export function replyOf(g: any): Reply {
    return g?.status === 'CONFIRMADA' ? 'confirmed' : g?.status === 'RECHAZADA' ? 'declined' : g?.status === 'NO_SÉ' ? 'unsure' : 'none';
}

const REPLY_LABEL: Record<Reply, string> = { confirmed: 'Confirmó', declined: 'No irá', unsure: 'No lo sabe', none: 'Sin respuesta' };
const REPLY_STYLE: Record<Reply, string> = {
    confirmed: 'bg-green-500/10 text-green-700', declined: 'bg-red-500/10 text-red-700',
    unsure: 'bg-amber-500/10 text-amber-800', none: 'bg-muted text-muted-foreground',
};

// WhatsApp no avisa si el mensaje se envió. Solo recordamos, en este dispositivo, que el organizador abrió el chat.
const openedKey = (resId: string, guestId: string) => `invite-opened:${resId}:${guestId}`;
function readOpened(resId: string, guestId: string): boolean {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(openedKey(resId, guestId)) === '1'; } catch { return false; }
}
function writeOpened(resId: string, guestId: string) {
    try { localStorage.setItem(openedKey(resId, guestId), '1'); } catch { /* sin almacenamiento: el estado solo dura la pantalla */ }
}

/**
 * Invitaciones de una reserva, para su ORGANIZADOR: una tarjeta por invitado.
 *  · con correo: el sistema envía la invitación cuando la reserva queda CONFIRMADA (aquí solo se informa);
 *  · sin correo: el organizador envía su enlace personal por WhatsApp (solo con la reserva confirmada).
 */
export default function InvitationsPanel({ res }: { res: any }) {
    const others = guestsOf(res).filter((g) => !g.is_organizer);
    const confirmed = res?.status === 'CONFIRMADA';
    const [opened, setOpened] = useState<Record<string, boolean>>(() =>
        Object.fromEntries(others.filter((g) => g.id).map((g) => [g.id, readOpened(res.id, g.id)])));
    const [showMsg, setShowMsg] = useState<string | null>(null);

    if (others.length === 0) return null;

    const input = (g: any): InviteInput => ({
        ticketBaseUrl: TICKET_URL, uniqueCode: res.unique_code, guestId: g.id, guestName: g.name,
        organizerName: guestsOf(res).find((x) => x.is_organizer)?.name, restaurantName: res.restaurant?.name, dateTime: res.date_time,
    });
    const mark = (g: any) => { writeOpened(res.id, g.id); setOpened((p) => ({ ...p, [g.id]: true })); };

    const whatsapp = (g: any) => {
        if (openWhatsApp(input(g), g.phone)) mark(g);
        else toast.error('No pudimos abrir WhatsApp. Usa «Copiar enlace».');
    };
    const copy = async (g: any) => {
        if (await copyInviteLink(input(g))) { mark(g); toast.success('Mensaje copiado. Pégalo donde prefieras.'); }
        else toast.error('No se pudo copiar el mensaje');
    };
    const share = async (g: any) => {
        const r = await shareInvite(input(g));
        if (r === 'shared' || r === 'whatsapp') mark(g);
        else if (r === 'copied') { mark(g); toast.success('Mensaje copiado. Pégalo donde prefieras.'); }
        else if (r === 'failed') toast.error('No se pudo compartir la invitación');
    };

    const isDone = (g: any) => replyOf(g) !== 'none' || (!!g.email && confirmed) || !!opened[g.id];
    const done = others.filter(isDone).length;

    return (
        <div className="space-y-3">
            <div className="rounded-2xl bg-muted/50 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs font-bold">
                    <span>{done} de {others.length} {others.length === 1 ? 'invitación lista' : 'invitaciones listas'}</span>
                    {!confirmed && <span className="text-muted-foreground font-semibold">Esperando al restaurante</span>}
                </div>
                <div className="h-1.5 rounded-full bg-border overflow-hidden" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={others.length}>
                    <div className="h-full bg-green-500" style={{ width: `${(done / others.length) * 100}%` }} />
                </div>
            </div>

            {!confirmed && (
                <p className="text-xs text-muted-foreground rounded-xl bg-muted/50 p-3">
                    Tu reserva aún no está confirmada. Cuando el restaurante la confirme, los invitados con correo recibirán su invitación y aquí podrás enviar los enlaces de WhatsApp.
                </p>
            )}

            <ul className="space-y-2">
                {others.map((g, i) => {
                    const reply = replyOf(g);
                    const hasEmail = !!g.email;
                    const sendable = confirmed && !!g.id && !hasEmail && reply !== 'confirmed' && reply !== 'declined';
                    const wasOpened = !!opened[g.id];
                    const noNotices = reply === 'confirmed' && !g.notify_consent_at && !hasEmail;
                    return (
                        <li key={g.id || i} className="rounded-2xl border border-border/60 p-3 space-y-2.5">
                            <div className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 leading-tight">
                                    <span className="block text-sm font-bold truncate">{g.name || 'Invitado'}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {hasEmail
                                            ? (confirmed ? 'Invitación enviada por correo' : 'Se enviará por correo al confirmarse')
                                            : wasOpened ? 'Enlace abierto en WhatsApp' : confirmed ? 'Falta enviar su enlace' : 'Recibirá un enlace de WhatsApp'}
                                    </span>
                                    {noNotices && <span className="block text-xs font-semibold text-amber-700">Sin avisos de cambios</span>}
                                </span>
                                <span className={`shrink-0 text-xs font-black px-2 py-0.5 rounded-full ${REPLY_STYLE[reply]}`}>{REPLY_LABEL[reply]}</span>
                            </div>

                            {sendable && (
                                <>
                                    <button type="button" onClick={() => whatsapp(g)}
                                        className="w-full h-11 rounded-xl bg-green-600 text-white font-bold text-sm flex items-center justify-center gap-2 active:scale-95">
                                        <MessageCircle className="w-4 h-4" /> {wasOpened ? 'Reenviar por WhatsApp' : 'Enviar por WhatsApp'}
                                    </button>
                                    <div className="grid grid-cols-2 gap-2">
                                        <button type="button" onClick={() => copy(g)} className="h-10 rounded-xl border border-border text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95"><Copy className="w-3.5 h-3.5" /> Copiar enlace</button>
                                        <button type="button" onClick={() => share(g)} className="h-10 rounded-xl border border-border text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95"><Share2 className="w-3.5 h-3.5" /> Compartir…</button>
                                    </div>
                                    <button type="button" onClick={() => setShowMsg(showMsg === g.id ? null : g.id)} className="text-xs font-bold text-primary underline">
                                        {showMsg === g.id ? 'Ocultar mensaje' : 'Ver mensaje'}
                                    </button>
                                    {showMsg === g.id && <p className="text-xs rounded-xl bg-muted/60 p-3 break-words whitespace-pre-wrap">{inviteMessageText(input(g))}</p>}
                                </>
                            )}
                        </li>
                    );
                })}
            </ul>
            {confirmed && others.some((g) => !g.email) && (
                <p className="text-xs text-muted-foreground">Cada enlace es personal: si lo reenvías o lo pones en un grupo, otra persona podría responder por tu invitado.</p>
            )}
        </div>
    );
}
