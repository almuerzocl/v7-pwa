'use client';

import { useState } from 'react';
import ContactCard from '@/components/ContactCard';
import ContactForm from '@/components/ContactForm';
import { UserPlus, Search } from 'lucide-react';
import type { Contact } from '@/types';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'react-hot-toast';
import { saveContactAction } from '@/app/actions/contacts-actions';

// Only Android Chrome implements the Contact Picker API today. On iOS and
// desktop there's no picker to fall back to, so the same button opens the
// manual form instead, relying on autocomplete for the OS-level autofill.
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
    const canImportNatively = hasContactPickerAPI();

    const handleAgendaSearch = async () => {
        if (!canImportNatively) {
            // iOS / desktop: no native picker available, fall back to the
            // manual form so the OS autofill (Contacts/keychain) can help.
            setShowForm(true);
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
                    <Search className="w-4 h-4" />
                    {isImporting ? 'Importando...' : 'Búsqueda en agenda de contactos'}
                </button>
            </div>

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
