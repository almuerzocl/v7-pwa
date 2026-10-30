'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search } from 'lucide-react';
import type { Contact } from '@/types';
import { RAIL, displayName, groupContacts, nearestPresentLetter } from '@/lib/contact-groups';

interface Props {
    contacts: Contact[];
    /** Ids ya agregados a la reserva: aparecen marcados y no se pueden volver a elegir. */
    alreadyIds: string[];
    onConfirm: (picked: Contact[]) => void;
    onClose: () => void;
}

function initials(c: Contact): string {
    const n = displayName(c).split(/\s+/).filter(Boolean);
    return ((n[0]?.[0] ?? '') + (n[1]?.[0] ?? '')).toUpperCase() || '?';
}

/**
 * «Mis contactos»: lista alfabética con encabezados de letra, índice A–Z al borde (toque o arrastre), buscador y
 * selección múltiple. Nunca muestra correos ni teléfonos: solo si el contacto recibe invitaciones por correo.
 */
export default function ContactPickerModal({ contacts, alreadyIds, onConfirm, onClose }: Props) {
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const listRef = useRef<HTMLDivElement>(null);
    const railRef = useRef<HTMLDivElement>(null);
    const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

    const groups = useMemo(() => groupContacts(contacts, query), [contacts, query]);
    const present = useMemo(() => new Set(groups.map((g) => g.letter)), [groups]);
    const already = useMemo(() => new Set(alreadyIds), [alreadyIds]);

    useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    const toggle = (id: string) =>
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });

    const jumpTo = (clientY: number) => {
        const rail = railRef.current;
        const list = listRef.current;
        if (!rail || !list) return;
        const r = rail.getBoundingClientRect();
        const idx = Math.floor(((clientY - r.top) / r.height) * RAIL.length);
        const letter = nearestPresentLetter(Math.min(RAIL.length - 1, Math.max(0, idx)), present);
        const el = letter ? sectionRefs.current[letter] : null;
        if (el) list.scrollTop = el.offsetTop;
    };

    return (
        <div className="fixed inset-0 z-[9500] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Mis contactos"
                className="relative bg-background w-full max-w-md h-[85vh] sm:h-[80vh] rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-5 pt-4 pb-3 space-y-3 border-b border-border/50">
                    <div className="flex items-center justify-between">
                        <h2 className="font-black text-base">Mis contactos <span className="text-xs font-semibold text-muted-foreground">{contacts.length}</span></h2>
                        <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-full p-1.5 border border-border/50 hover:bg-muted"><X className="w-4 h-4" /></button>
                    </div>
                    <label className="relative block">
                        <span className="sr-only">Buscar por nombre</span>
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Buscar por nombre"
                            className="w-full h-11 pl-9 pr-3 rounded-xl border border-border bg-background text-base"
                        />
                    </label>
                </div>

                <div className="flex-1 min-h-0 flex">
                    <div ref={listRef} className="relative flex-1 min-w-0 overflow-y-auto px-4 pb-4" data-testid="contact-list">
                        {contacts.length === 0 && (
                            <p className="text-sm text-muted-foreground text-center py-10">Aún no tienes contactos guardados. Agrega un invitado nuevo y quedará aquí para la próxima vez.</p>
                        )}
                        {contacts.length > 0 && groups.length === 0 && (
                            <p className="text-sm text-muted-foreground text-center py-10">Ningún contacto coincide con «{query}».</p>
                        )}
                        {groups.map((g) => (
                            <section key={g.letter} ref={(el) => { sectionRefs.current[g.letter] = el; }} aria-label={`Contactos con ${g.letter}`}>
                                <h3 className="sticky top-0 z-[1] bg-background/95 backdrop-blur text-xs font-black text-primary py-1.5">{g.letter}</h3>
                                <ul>
                                    {g.items.map((c) => {
                                        const isAlready = already.has(c.id);
                                        const isPicked = isAlready || picked.has(c.id);
                                        return (
                                            <li key={c.id}>
                                                <label className={`flex items-center gap-3 py-2.5 min-h-[48px] border-b border-border/40 ${isAlready ? 'opacity-60' : 'cursor-pointer'}`}>
                                                    <span className="w-9 h-9 rounded-full bg-primary/10 text-primary font-black text-xs flex items-center justify-center shrink-0" aria-hidden>{initials(c)}</span>
                                                    <span className="min-w-0 flex-1 leading-tight">
                                                        <span className="block text-sm font-bold truncate">{displayName(c)}</span>
                                                        <span className="block text-xs text-muted-foreground">
                                                            {isAlready ? 'Ya agregado' : c.email ? 'Recibe invitaciones por correo' : 'Sin correo: enlace de WhatsApp'}
                                                        </span>
                                                    </span>
                                                    <input
                                                        type="checkbox"
                                                        checked={isPicked}
                                                        disabled={isAlready}
                                                        onChange={() => toggle(c.id)}
                                                        className="w-5 h-5 accent-[hsl(var(--primary))] shrink-0"
                                                        aria-label={`Elegir a ${displayName(c)}`}
                                                    />
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        ))}
                    </div>

                    {/* Índice A–Z: toque o arrastre. La lista tiene encabezados y buscador, así que el índice es un atajo para el dedo. */}
                    <div
                        ref={railRef}
                        aria-hidden
                        className="w-7 shrink-0 flex flex-col justify-between py-2 touch-none select-none text-xs font-black text-primary"
                        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); jumpTo(e.clientY); }}
                        onPointerMove={(e) => { if (e.buttons > 0) jumpTo(e.clientY); }}
                    >
                        {RAIL.map((l) => (
                            <span key={l} className={`text-center leading-none ${present.has(l) ? '' : 'opacity-25'}`}>{l}</span>
                        ))}
                    </div>
                </div>

                <div className="px-5 py-3 border-t border-border/50">
                    <button
                        type="button"
                        disabled={picked.size === 0}
                        onClick={() => onConfirm(contacts.filter((c) => picked.has(c.id)))}
                        className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-black text-sm disabled:opacity-40"
                    >
                        {picked.size > 0 ? `Agregar (${picked.size})` : 'Elige a quién invitar'}
                    </button>
                </div>
            </div>
        </div>
    );
}
