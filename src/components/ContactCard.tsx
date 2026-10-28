'use client';

import { Contact } from '@/types';
import { getInitials } from '@/lib/core-business/ui-helpers';

interface ContactCardProps {
    contact: Contact;
    onEdit: (contact: Contact) => void;
    onDelete: (id: string) => void;
}

export default function ContactCard({ contact, onEdit, onDelete }: ContactCardProps) {
    const firstName = contact.first_name || 'Invitado';
    const fullName = `${firstName} ${contact.last_name || ''}`.trim();
    const initial = getInitials(firstName, contact.last_name);

    return (
        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow flex justify-between items-center group">
            <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center text-xl font-bold text-orange-600 overflow-hidden">
                    {contact.avatar_url ? (
                        <img src={contact.avatar_url} alt={fullName} className="w-full h-full object-cover" />
                    ) : (
                        initial
                    )}
                </div>
                <div>
                    <h3 className="font-semibold text-gray-900">{fullName}</h3>
                    <div className="text-sm text-gray-500 flex flex-col">
                        {contact.email && <span>{contact.email}</span>}
                        {contact.whatsapp_phone && <span>{contact.whatsapp_phone}</span>}
                    </div>
                </div>
            </div>
            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={() => onEdit(contact)}
                    className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-colors"
                    title="Editar"
                >
                    ✏️
                </button>
                <button
                    onClick={() => onDelete(contact.id)}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Eliminar"
                >
                    🗑️
                </button>
            </div>
        </div>
    );
}
