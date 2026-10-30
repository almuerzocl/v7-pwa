'use client';

import { useRef, useState } from 'react';
import ContactCard from '@/components/ContactCard';
import ContactPickerModal from '@/components/blocks/ContactPickerModal';
import { UserPlus, Search, FileUp, Users } from 'lucide-react';
import type { Contact } from '@/types';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'react-hot-toast';
import { saveContactAction } from '@/app/actions/contacts-actions';
import { parseVCards, normalizePhone, VCARD_MAX_BYTES } from '@/lib/vcard';

// Only Android Chrome implements the Contact Picker API today. On iOS and
// desktop the same button imports a vCard (.vcf) file instead, which the
// user shares from the Contacts app; it is read in the browser, never uploaded.
function hasContactPickerAPI(): boolean {
    return typeof navigator !== 'undefined' && 'contacts' in navigator && 'ContactsManager' in window;
}

interface InviteesSelectorProps {
    contacts: Contact[]; // all contacts of the user
    selected: Contact[]; // currently selected invitees
    onAddInvitee: (c: Contact) => void;
    onRemoveInvitee: (id: string) => void;
    onContactSaved?: () => void; // refresh the user's saved contacts list
}

export default function InviteesSelector({
    contacts,
    selected,
    onAddInvitee,
    onRemoveInvitee,
    onContactSaved,
}: InviteesSelectorProps) {
    const { user } = useAuth();
    const [showPicker, setShowPicker] = useState(false);
    const [newName, setNewName] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const canImportNatively = hasContactPickerAPI();

    const handleVCardFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        e.target.value = ''; // permite elegir el mismo archivo otra vez
        if (files.length === 0) return;
        if (files.some(f => f.size > VCARD_MAX_BYTES)) { toast.error('El archivo es demasiado grande'); return; }

        setIsImporting(true);
        try {
            const parsed = (await Promise.all(files.map(f => f.text()))).flatMap(parseVCards);
            if (parsed.length === 0) { toast.error('No encontramos contactos con nombre y teléfono o correo en el archivo'); return; }

            let added = 0;
            for (const c of parsed) {
                const phone = c.phone ? normalizePhone(c.phone) : null;
                // Si ya lo tiene guardado (mismo teléfono o correo), lo reutiliza en vez de duplicarlo.
                const existing = contacts.find(x =>
                    (phone && x.whatsapp_phone && normalizePhone(x.whatsapp_phone) === phone) ||
                    (c.email && x.email && x.email.toLowerCase() === c.email.toLowerCase()));
                if (existing) { onAddInvitee(existing); added++; continue; }
                const result = await saveContactAction(user?.id || '', {
                    first_name: c.first_name || 'Invitado',
                    last_name: c.last_name,
                    email: c.email,
                    whatsapp_phone: phone,
                });
                if (result.success && result.contact) { onAddInvitee(result.contact as any); added++; }
                else console.error('Error saving contact from vCard:', result.error);
            }
            if (added > 0) {
                onContactSaved?.();
                toast.success(`${added} contacto${added > 1 ? 's' : ''} añadido${added > 1 ? 's' : ''}`);
            } else {
                toast.error('No se pudo guardar el contacto');
            }
        } catch (err) {
            console.error('Error importing vCard:', err);
            toast.error('No se pudo leer el archivo');
        } finally {
            setIsImporting(false);
        }
    };

    // Invitado nuevo: solo el nombre es obligatorio. Sin correo, al confirmarse la reserva se le da al organizador un enlace de WhatsApp.
    const addNew = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError(null);
        const name = newName.trim();
        const email = newEmail.trim().toLowerCase();
        if (!name) { setFormError('Escribe el nombre de tu invitado'); return; }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setFormError('Revisa el correo: debe ser como nombre@correo.cl'); return; }
        setIsSaving(true);
        try {
            const [first, ...rest] = name.split(/\s+/);
            const result = await saveContactAction(user?.id || '', { first_name: first, last_name: rest.join(' '), email: email || null, whatsapp_phone: null });
            if (result.success && result.contact) {
                onAddInvitee(result.contact as any);
                onContactSaved?.();
                setNewName('');
                setNewEmail('');
            } else {
                toast.error('No se pudo guardar el contacto');
            }
        } catch (err) {
            console.error('Error saving contact in selector:', err);
            toast.error('No se pudo guardar el contacto');
        } finally {
            setIsSaving(false);
        }
    };

    const handleAgendaSearch = async () => {
        if (!canImportNatively) {
            fileInputRef.current?.click();
            return;
        }

        setIsImporting(true);
        try {
            const props = ['name', 'email', 'tel'];
            const opts = { multiple: true };
            const phoneContacts = await (navigator as any).contacts.select(props, opts);

            if (!phoneContacts || phoneContacts.length === 0) return;

            let savedCount = 0;
            for (const c of phoneContacts) {
                const nameParts = c.name?.[0]?.split(' ') || ['Invitado'];
                const firstName = nameParts[0];
                const lastName = nameParts.slice(1).join(' ') || '';

                const result = await saveContactAction(user?.id || '', {
                    first_name: firstName,
                    last_name: lastName,
                    email: c.email?.[0] || null,
                    whatsapp_phone: c.tel?.[0] || null,
                });

                if (result.success && result.contact) {
                    onAddInvitee(result.contact as any);
                    savedCount++;
                } else {
                    console.error('Error saving contact from agenda:', result.error);
                }
            }

            if (savedCount > 0) {
                onContactSaved?.();
                toast.success(`${savedCount} contacto${savedCount > 1 ? 's' : ''} añadido${savedCount > 1 ? 's' : ''}`);
            } else {
                toast.error('No se pudo guardar el contacto');
            }
        } catch (ex) {
            console.error('Error importing contacts:', ex);
            toast.error('Error al importar contactos');
        } finally {
            setIsImporting(false);
        }
    };

    return (
        <div className="space-y-4">
            <h3 className="font-semibold text-gray-800 mb-2"><UserPlus className="w-5 h-5 inline-block mr-1" /> Invitados</h3>

            {/* Invitados ya elegidos, con el canal por el que recibirán su invitación */}
            <div className="grid gap-3 md:grid-cols-2">
                {selected.map((c) => (
                    <div key={c.id} className="space-y-1">
                        <ContactCard
                            contact={c}
                            onEdit={() => { }}
                            onDelete={() => onRemoveInvitee(c.id)}
                        />
                        <p className="text-xs text-gray-500 px-1">
                            {c.email
                                ? 'Le enviaremos la invitación por correo cuando se confirme la reserva.'
                                : 'Te daremos un enlace de WhatsApp para enviársela cuando se confirme la reserva.'}
                        </p>
                    </div>
                ))}
            </div>

            <button
                type="button"
                onClick={() => setShowPicker(true)}
                className="w-full py-3 bg-orange-50 text-orange-700 rounded-xl hover:bg-orange-100 font-bold text-sm flex items-center justify-center gap-2"
            >
                <Users className="w-4 h-4" /> Mis contactos{contacts.length > 0 ? ` (${contacts.length})` : ''}
            </button>

            {/* Invitado nuevo: nombre y, si quiere, correo. En estos campos no se ofrece autocompletar: iOS sugeriría los datos del propio organizador. */}
            <form onSubmit={addNew} className="rounded-2xl border border-dashed border-gray-300 p-3 space-y-2">
                <p className="text-sm font-bold text-gray-800">Invitado nuevo</p>
                <label htmlFor="new-invitee-name" className="sr-only">Nombre</label>
                <input id="new-invitee-name" type="text" autoComplete="off" value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="Nombre" className="w-full h-11 px-3 border rounded-xl text-base focus:ring-2 focus:ring-orange-500" />
                <label htmlFor="new-invitee-email" className="sr-only">Correo (opcional)</label>
                <input id="new-invitee-email" type="email" inputMode="email" autoComplete="off" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="Correo (opcional)" className="w-full h-11 px-3 border rounded-xl text-base focus:ring-2 focus:ring-orange-500" />
                <p className="text-xs text-gray-500">
                    {newEmail.trim() ? 'Se enviará por correo cuando el restaurante confirme la reserva.' : 'Sin correo, te damos un enlace de WhatsApp para enviárselo.'}
                </p>
                {formError && <p role="alert" className="text-xs font-semibold text-red-600">{formError}</p>}
                <button type="submit" disabled={isSaving}
                    className="w-full h-11 rounded-xl bg-gray-900 text-white font-bold text-sm disabled:opacity-50">
                    {isSaving ? 'Guardando...' : 'Agregar invitado'}
                </button>
            </form>

            <button
                type="button"
                disabled={isImporting}
                onClick={handleAgendaSearch}
                className="w-full py-2 bg-blue-50 text-blue-700 rounded-xl hover:bg-blue-100 font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
                {canImportNatively ? <Search className="w-4 h-4" /> : <FileUp className="w-4 h-4" />}
                {isImporting ? 'Importando...' : canImportNatively ? 'Búsqueda en agenda de contactos' : 'Importar tarjeta de contacto'}
            </button>
            {!canImportNatively && (
                <>
                    <input ref={fileInputRef} type="file" multiple accept=".vcf,.vcard,text/vcard,text/x-vcard,text/directory" className="hidden" onChange={handleVCardFile} />
                    <p className="text-xs text-gray-500">
                        En el iPhone: abre Contactos, elige a la persona, toca Compartir contacto → Guardar en Archivos, y selecciónala aquí.
                    </p>
                </>
            )}

            {showPicker && (
                <ContactPickerModal
                    contacts={contacts}
                    alreadyIds={selected.map((c) => c.id)}
                    onConfirm={(picked) => { picked.forEach(onAddInvitee); setShowPicker(false); }}
                    onClose={() => setShowPicker(false)}
                />
            )}
        </div>
    );
}
