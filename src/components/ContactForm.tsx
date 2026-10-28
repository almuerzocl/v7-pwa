'use client';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import PhoneInput, { formatChileanPhone } from '@/components/ui/PhoneInput';

const contactSchema = z.object({
    first_name: z.string().min(2, 'El nombre es requerido'),
    last_name: z.string().optional(),
    email: z.string().email('Email inválido').optional().or(z.literal('')),
    whatsapp_phone: z.string().optional(),
});

type ContactFormValues = z.infer<typeof contactSchema>;

interface ContactFormProps {
    initialData?: ContactFormValues;
    onSubmit: (data: ContactFormValues) => Promise<void>;
    onCancel: () => void;
    isSubmitting?: boolean;
}

export default function ContactForm({ initialData, onSubmit, onCancel, isSubmitting = false }: ContactFormProps) {
    const {
        register,
        control,
        handleSubmit,
        formState: { errors },
    } = useForm<ContactFormValues>({
        resolver: zodResolver(contactSchema as any),
        defaultValues: initialData || {
            first_name: '',
            last_name: '',
            email: '',
            whatsapp_phone: '',
        },
    });

    return (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label htmlFor="first_name" className="block text-sm font-medium text-gray-700 mb-1">
                        Nombre *
                    </label>
                    <input
                        type="text"
                        id="first_name"
                        autoComplete="given-name"
                        {...register('first_name')}
                        className="w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none text-gray-900"
                        placeholder="Juan"
                    />
                    {errors.first_name && <p className="text-red-500 text-sm mt-1">{errors.first_name.message}</p>}
                </div>
                <div>
                    <label htmlFor="last_name" className="block text-sm font-medium text-gray-700 mb-1">
                        Apellido
                    </label>
                    <input
                        type="text"
                        id="last_name"
                        autoComplete="family-name"
                        {...register('last_name')}
                        className="w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none text-gray-900"
                        placeholder="Pérez"
                    />
                </div>
            </div>

            <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                    Email
                </label>
                <input
                    type="email"
                    id="email"
                    autoComplete="email"
                    {...register('email')}
                    className="w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none text-gray-900"
                    placeholder="juan@ejemplo.com"
                />
                {errors.email && <p className="text-red-500 text-sm mt-1">{errors.email.message}</p>}
            </div>

            <div>
                <label htmlFor="whatsapp_phone" className="block text-sm font-medium text-gray-700 mb-1">
                    Teléfono (WhatsApp)
                </label>
                <Controller
                    name="whatsapp_phone"
                    control={control}
                    render={({ field }) => (
                        <PhoneInput
                            id="whatsapp_phone"
                            autoComplete="tel"
                            value={field.value ?? ''}
                            onChange={field.onChange}
                            className="w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none text-gray-900"
                        />
                    )}
                />
            </div>

            <div className="flex gap-3 pt-4">
                <button
                    type="button"
                    onClick={onCancel}
                    className="flex-1 py-3 border border-gray-300 text-gray-700 rounded-xl font-semibold hover:bg-gray-50 transition-colors"
                >
                    Cancelar
                </button>
                <button
                    type="submit"
                    disabled={isSubmitting}
                    className="flex-1 py-3 bg-orange-600 text-white rounded-xl font-semibold hover:bg-orange-700 transition-colors disabled:opacity-50"
                >
                    {isSubmitting ? 'Guardando...' : 'Guardar Contacto'}
                </button>
            </div>
        </form>
    );
}
