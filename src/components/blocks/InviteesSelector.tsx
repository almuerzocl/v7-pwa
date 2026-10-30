'use client';

import { useRef, useState } from 'react';
import ContactCard from '@/components/ContactCard';
import ContactForm from '@/components/ContactForm';
import { UserPlus, Search, FileUp } from 'lucide-react';
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
    const [showForm, setShowForm] = useState(false);
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

            {/* List of already selected invitees */}
            <div className="grid gap-3 md:grid-cols-2">
                {selected.map((c) => (
                    <ContactCard
                        key={c.id}
                        contact={c}
                        onEdit={() => { }}
                        onDelete={() => onRemoveInvitee(c.id)}
                    />
                ))}
            </div>

            {/* Quick add from existing contacts */}
            <select
                className="w-full p-3 border rounded-xl focus:ring-2 focus:ring-orange-500"
                onChange={(e) => {
                    const id = e.target.value;
                    if (!id) return;
                    const contact = contacts.find((c) => c.id === id);
                    if (contact) onAddInvitee(contact);
                }}
            >
                <option value="">+ Añadir de mis contactos</option>
                {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                        {c.first_name} {c.last_name}
                    </option>
                ))}
            </select>

            <div className="grid grid-cols-2 gap-3">
                <button
                    onClick={() => setShowForm(true)}
                    className="py-2 bg-gray-100 text-gray-800 rounded-xl hover:bg-gray-200 font-medium text-sm"
                >
                    + Nuevo Contacto
                </button>
                <button
                    disabled={isImporting}
                    onClick={handleAgendaSearch}
                    className="py-2 bg-blue-50 text-blue-700 rounded-xl hover:bg-blue-100 font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                    {canImportNatively ? <Search className="w-4 h-4" /> : <FileUp className="w-4 h-4" />}
                    {isImporting ? 'Importando...' : canImportNatively ? 'Búsqueda en agenda de contactos' : 'Importar tarjeta de contacto'}
                </button>
            </div>
            {!canImportNatively && (
                <>
                    <input ref={fileInputRef} type="file" multiple accept=".vcf,.vcard,text/vcard,text/x-vcard,text/directory" className="hidden" onChange={handleVCardFile} />
                    <p className="text-xs text-gray-500">
                        En el iPhone: abre Contactos, elige a la persona, toca Compartir contacto → Guardar en Archivos, y selecciónala aquí.
                    </p>
                </>
            )}

            {showForm && (
                <div className="bg-white/50 backdrop-blur-sm p-4 rounded-2xl border border-dashed border-gray-200 animate-in fade-in zoom-in duration-200">
                    <ContactForm
                        onCancel={() => setShowForm(false)}
                        isSubmitting={isSaving}
                        onSubmit={async (data) => {
                            setIsSaving(true);
                            try {
                                const result = await saveContactAction(user?.id || '', {
                                    first_name: data.first_name,
                                    last_name: data.last_name,
                                    email: data.email || null,
                                    whatsapp_phone: data.whatsapp_phone || null,
                                });

                                if (result.success && result.contact) {
                                    onAddInvitee(result.contact as any);
                                    onContactSaved?.();
                                    setShowForm(false);
                                } else {
                                    toast.error('No se pudo guardar el contacto');
                                }
                            } catch (err) {
                                console.error('Error saving contact in selector:', err);
                                toast.error('No se pudo guardar el contacto');
                            } finally {
                                setIsSaving(false);
                            }
                        }}
                    />
                </div>
            )}
        </div>
    );
}
