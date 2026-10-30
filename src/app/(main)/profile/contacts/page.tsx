"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { getInitials } from "@/lib/core-business/ui-helpers";
import { Contact } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PhoneInput, { formatChileanPhone } from "@/components/ui/PhoneInput";
import { findInterconnectedNumbersAction } from "@/app/actions/guests-actions";
import { saveContactAction } from "@/app/actions/contacts-actions";
import { parseVCards, normalizePhone, VCARD_MAX_BYTES } from "@/lib/vcard";
import {
    UserPlus,
    Search,
    Trash2,
    Edit2,
    User,
    Loader2,
    ChevronLeft,
    UserCircle,
    Plus,
    X,
    Check,
    Smartphone,
    FileUp,
    Shield,
    Monitor
} from "lucide-react";
import Link from "next/link";
import toast from "react-hot-toast";

type Platform = "ios" | "android" | "web";

function detectPlatform(): Platform {
    if (typeof navigator === "undefined") return "web";
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return "ios";
    if (/Android/.test(ua)) return "android";
    return "web";
}

function hasContactPickerAPI(): boolean {
    return typeof navigator !== "undefined" && "contacts" in navigator && "ContactsManager" in window;
}

export default function ContactsPage() {
    const { user, profile, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!authLoading && !user) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        }
    }, [user, authLoading, router, pathname]);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [isAdding, setIsAdding] = useState(false);
    const [editingContact, setEditingContact] = useState<Contact | null>(null);
    const [interconnectedNumbers, setInterconnectedNumbers] = useState<Set<string>>(new Set());
    const [addressBookConsent, setAddressBookConsent] = useState<boolean>(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem("addressbook_consent") === "true";
    });
    const platform = typeof window !== "undefined" ? detectPlatform() : "web";
    const canImportNatively = hasContactPickerAPI();
    const [formData, setFormData] = useState({
        first_name: "",
        last_name: "",
        email: "",
        whatsapp_phone: ""
    });

    const handleConsentChange = (checked: boolean) => {
        setAddressBookConsent(checked);
        localStorage.setItem("addressbook_consent", checked ? "true" : "false");
    };

    const fetchContacts = useCallback(async () => {
        if (!user) return;
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('contacts')
                .select('*')
                .eq('owner_id', user.id)
                .order('created_at', { ascending: false });

            if (error) throw error;
            setContacts(data || []);
        } catch (err: any) {
            console.error("Error fetching contacts:", err);
            toast.error("No pudimos cargar tus contactos");
        } finally {
            setLoading(false);
        }
    }, [user]);

    const checkInterconnectivity = useCallback(async (contactList: Contact[]) => {
        const numbers = contactList.map(c => c.whatsapp_phone).filter(Boolean) as string[];
        if (numbers.length === 0) return;

        try {
            // Server action: profiles de terceros ya no es legible desde el navegador
            const found = await findInterconnectedNumbersAction(numbers);
            setInterconnectedNumbers(new Set(found));
        } catch (e) {
            console.error("Interconnect error", e);
        }
    }, []);

    useEffect(() => {
        fetchContacts();
    }, [fetchContacts]);

    useEffect(() => {
        if (contacts.length > 0) {
            checkInterconnectivity(contacts);
        }
    }, [contacts, checkInterconnectivity]);

    const vcfInputRef = useRef<HTMLInputElement>(null);

    // Sin selector nativo (iPhone, escritorio): importa tarjetas de contacto .vcf. Se leen en el dispositivo, no se suben.
    const handleVCardFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!user || files.length === 0) return;
        if (files.some(f => f.size > VCARD_MAX_BYTES)) { toast.error("El archivo es demasiado grande"); return; }
        setLoading(true);
        try {
            const parsed = (await Promise.all(files.map(f => f.text()))).flatMap(parseVCards);
            if (parsed.length === 0) { toast.error("No encontramos contactos con nombre y teléfono o correo en el archivo"); return; }
            let imported = 0, skipped = 0;
            for (const c of parsed) {
                const phone = c.phone ? normalizePhone(c.phone) : null;
                const exists = contacts.some(x =>
                    (phone && x.whatsapp_phone && normalizePhone(x.whatsapp_phone) === phone) ||
                    (c.email && x.email && x.email.toLowerCase() === c.email.toLowerCase()));
                if (exists) { skipped++; continue; }
                const r = await saveContactAction(user.id, { first_name: c.first_name || "Contacto", last_name: c.last_name, email: c.email, whatsapp_phone: phone });
                if (r.success) imported++;
            }
            if (imported > 0) { toast.success(`${imported} contacto${imported > 1 ? "s" : ""} importado${imported > 1 ? "s" : ""}.`); fetchContacts(); }
            else if (skipped > 0) toast.success("Esos contactos ya estaban en tu agenda.");
            else toast.error("No se pudo importar el contacto.");
        } catch (err) {
            console.error("Error importing vCard:", err);
            toast.error("No pudimos leer el archivo.");
        } finally {
            setLoading(false);
        }
    };

    const handleImportFromPhone = async () => {
        if (!user) return;
        if (!addressBookConsent) {
            toast.error("Debes autorizar el acceso a tu libreta de direcciones primero.");
            return;
        }
        if (!canImportNatively) {
            toast.error("La importación directa no está disponible en tu navegador. Agrega contactos manualmente.");
            return;
        }

        try {
            const props = ['name', 'email', 'tel'];
            const opts = { multiple: true };
            const phoneContacts = await (navigator as any).contacts.select(props, opts);

            if (!phoneContacts || phoneContacts.length === 0) return;

            setLoading(true);
            toast.loading("Sincronizando contactos...", { id: "import-contacts" });

            let importedCount = 0;
            let skippedCount = 0;

            for (const pc of phoneContacts) {
                const fullName = pc.name?.[0] || "";
                const names = fullName.split(" ");
                const firstName = names[0] || "Contacto";
                const lastName = names.slice(1).join(" ") || "";
                // Clean phone number (keep only digits and +)
                const phone = (pc.tel?.[pc.tel.length - 1] || "").replace(/[^\d+]/g, "");
                const email = pc.email?.[0] || "";

                if (!phone) {
                    skippedCount++;
                    continue;
                }

                // Check if already exists in our DB to avoid duplicates
                const { data: existing } = await supabase
                    .from('contacts')
                    .select('id')
                    .eq('owner_id', user.id)
                    .eq('whatsapp_phone', phone)
                    .maybeSingle();

                if (existing) {
                    skippedCount++;
                    continue;
                }

                const { error } = await supabase
                    .from('contacts')
                    .insert([{
                        owner_id: user.id,
                        first_name: firstName,
                        last_name: lastName,
                        email: email,
                        whatsapp_phone: phone
                    }]);

                if (!error) importedCount++;
                else console.error("Error importing one contact:", error);
            }

            toast.dismiss("import-contacts");
            if (importedCount > 0) {
                toast.success(`${importedCount} contactos sincronizados correctamente.`);
                fetchContacts();
            } else if (skippedCount > 0) {
                toast.success("Tus contactos ya estaban sincronizados.");
            }
        } catch (err: any) {
            console.error("Error importing contacts:", err);
            toast.error("No pudimos acceder a tus contactos.");
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!user) return;

        if (!formData.first_name || !formData.whatsapp_phone) {
            toast.error("Nombre y teléfono son obligatorios");
            return;
        }

        setLoading(true);
        try {
            if (editingContact) {
                const { error } = await supabase
                    .from('contacts')
                    .update({
                        first_name: formData.first_name,
                        last_name: formData.last_name,
                        email: formData.email,
                        whatsapp_phone: formData.whatsapp_phone
                    })
                    .eq('id', editingContact.id);

                if (error) throw error;
                toast.success("Contacto actualizado");
            } else {
                const { error } = await supabase
                    .from('contacts')
                    .insert([{
                        owner_id: user.id,
                        first_name: formData.first_name,
                        last_name: formData.last_name,
                        email: formData.email,
                        whatsapp_phone: formData.whatsapp_phone
                    }]);

                if (error) throw error;
                toast.success("Contacto guardado");
            }

            setFormData({ first_name: "", last_name: "", email: "", whatsapp_phone: "" });
            setIsAdding(false);
            setEditingContact(null);
            fetchContacts();
        } catch (err: any) {
            console.error("Error saving contact:", err);
            toast.error("Error al guardar el contacto");
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("¿Seguro que quieres eliminar este contacto?")) return;

        setLoading(true);
        try {
            const { error } = await supabase
                .from('contacts')
                .delete()
                .eq('id', id);

            if (error) throw error;
            toast.success("Contacto eliminado");
            fetchContacts();
        } catch (err: any) {
            console.error("Error deleting contact:", err);
            toast.error("Error al eliminar");
        } finally {
            setLoading(false);
        }
    };

    const startEdit = (contact: Contact) => {
        setEditingContact(contact);
        setFormData({
            first_name: contact.first_name || "",
            last_name: contact.last_name || "",
            email: contact.email || "",
            whatsapp_phone: contact.whatsapp_phone || ""
        });
        setIsAdding(true);
    };

    const filteredContacts = contacts.filter(c =>
        (c.first_name + " " + c.last_name).toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.email?.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (authLoading || !user) return null;

    return (
        <div className="flex flex-col min-h-screen bg-slate-50/50 pb-20">
            {/* Header */}
            <div className="bg-background border-b border-border sticky top-0 z-50 p-4">
                <div className="max-w-lg mx-auto flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Link href="/profile">
                            <Button variant="ghost" size="icon" className="rounded-full">
                                <ChevronLeft className="w-6 h-6" />
                            </Button>
                        </Link>
                        <div>
                            <h1 className="text-xl font-black tracking-tight">Agenda de Contactos</h1>
                            <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">Gestión de Invitados</p>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        {!isAdding && !canImportNatively && (
                            <>
                                <input ref={vcfInputRef} type="file" multiple accept=".vcf,.vcard,text/vcard,text/x-vcard,text/directory" className="hidden" onChange={handleVCardFile} />
                                <Button
                                    onClick={() => vcfInputRef.current?.click()}
                                    variant="outline"
                                    size="icon"
                                    className="rounded-full shadow-sm border-primary/20 text-primary"
                                    title="Importar tarjeta de contacto (.vcf)"
                                    aria-label="Importar tarjeta de contacto (.vcf)"
                                >
                                    <FileUp className="w-5 h-5" />
                                </Button>
                            </>
                        )}
                        {!isAdding && addressBookConsent && canImportNatively && (
                            <Button
                                onClick={handleImportFromPhone}
                                variant="outline"
                                size="icon"
                                className="rounded-full shadow-sm border-primary/20 text-primary"
                                title="Importar del teléfono"
                            >
                                <Smartphone className="w-5 h-5" />
                            </Button>
                        )}
                        {!isAdding && (
                            <Button
                                onClick={() => setIsAdding(true)}
                                size="icon"
                                className="rounded-full shadow-lg shadow-primary/20"
                            >
                                <Plus className="w-5 h-5" />
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            <div className="max-w-lg mx-auto w-full p-4 space-y-6">

                {/* Address Book Consent */}
                {!isAdding && (
                    <div
                        onClick={() => handleConsentChange(!addressBookConsent)}
                        className={`flex items-start gap-4 p-4 rounded-3xl border cursor-pointer transition-all select-none ${
                            addressBookConsent
                                ? "bg-primary/5 border-primary/20"
                                : "bg-background border-border hover:border-primary/20"
                        }`}
                    >
                        <div className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                            addressBookConsent ? "bg-primary border-primary" : "border-muted-foreground/40"
                        }`}>
                            {addressBookConsent && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex-1 space-y-1">
                            <p className="text-sm font-bold text-foreground leading-tight">
                                Autorizo el acceso a mi libreta de direcciones
                            </p>
                            <p className="text-xs text-muted-foreground leading-snug">
                                {platform === "ios" && (
                                    <>
                                        <span className="font-bold text-foreground/70">iPhone / iPad: </span>
                                        Safari no deja que una web lea tu agenda. Importa tarjetas de contacto: en Contactos elige a la persona, toca Compartir contacto, luego Guardar en Archivos, y selecciónala con el botón de archivo de arriba.
                                    </>
                                )}
                                {platform === "android" && (
                                    <>
                                        <span className="font-bold text-foreground/70">Android: </span>
                                        Permite importar contactos desde tu dispositivo Android usando el selector nativo del sistema.
                                    </>
                                )}
                                {platform === "web" && (
                                    <>
                                        <span className="font-bold text-foreground/70">Navegador web: </span>
                                        La importación directa no está disponible en escritorio. Puedes agregar contactos manualmente o importar un archivo de tarjetas de contacto (.vcf).
                                    </>
                                )}
                            </p>
                        </div>
                        <div className="shrink-0 mt-0.5">
                            {platform === "ios"     && <Smartphone className="w-4 h-4 text-muted-foreground/50" />}
                            {platform === "android" && <Smartphone className="w-4 h-4 text-muted-foreground/50" />}
                            {platform === "web"     && <Monitor    className="w-4 h-4 text-muted-foreground/50" />}
                        </div>
                    </div>
                )}

                {/* Search */}
                {!isAdding && (
                    <div className="relative">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                            placeholder="Buscar en mis contactos..."
                            className="bg-background border-transparent shadow-sm h-12 rounded-2xl pl-11 focus-visible:ring-primary/20"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>
                )}

                {/* Adding/Editing Form */}
                {isAdding ? (
                    <div className="bg-background border border-border p-6 rounded-[2rem] shadow-sm space-y-6 animate-in fade-in slide-in-from-top-4 duration-300">
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-black tracking-tight">
                                {editingContact ? "Editar Contacto" : "Nuevo Contacto"}
                            </h2>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    setIsAdding(false);
                                    setEditingContact(null);
                                    setFormData({ first_name: "", last_name: "", email: "", whatsapp_phone: "" });
                                }}
                                className="rounded-full h-8 w-8 p-0"
                            >
                                <X className="w-5 h-5" />
                            </Button>
                        </div>

                        <form onSubmit={handleSave} className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground ml-1">Nombre</Label>
                                    <Input
                                        placeholder="ej: Juan"
                                        className="h-12 bg-muted/30 border-transparent rounded-xl"
                                        value={formData.first_name}
                                        onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground ml-1">Apellido</Label>
                                    <Input
                                        placeholder="ej: Perez"
                                        className="h-12 bg-muted/30 border-transparent rounded-xl"
                                        value={formData.last_name}
                                        onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground ml-1">WhatsApp / Teléfono</Label>
                                <PhoneInput
                                    className="h-12 bg-muted/30 border-transparent rounded-xl"
                                    value={formData.whatsapp_phone}
                                    onChange={v => setFormData({ ...formData, whatsapp_phone: v })}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label className="text-xs uppercase tracking-wider font-bold text-muted-foreground ml-1">Email (Opcional)</Label>
                                <Input
                                    type="email"
                                    placeholder="correo@ejemplo.com"
                                    className="h-12 bg-muted/30 border-transparent rounded-xl"
                                    value={formData.email}
                                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                />
                            </div>

                            <Button disabled={loading} className="w-full h-14 rounded-2xl font-black text-lg mt-4 shadow-lg shadow-primary/10">
                                {loading && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
                                {editingContact ? "Actualizar" : "Guardar Contacto"}
                            </Button>
                        </form>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {loading && contacts.length === 0 ? (
                            <div className="flex flex-col items-center justify-center p-12 space-y-4">
                                <Loader2 className="w-10 h-10 text-primary animate-spin" />
                                <p className="text-sm font-bold text-muted-foreground">Cargando tus contactos...</p>
                            </div>
                        ) : filteredContacts.length > 0 ? (
                            filteredContacts.map((contact) => (
                                <div
                                    key={contact.id}
                                    className="bg-card border border-border p-4 rounded-3xl flex items-center justify-between group hover:border-primary/20 transition-all"
                                >
                                    <div className="flex items-center gap-4">
                                        <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary font-black">
                                            {getInitials(contact.first_name, contact.last_name)}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <p className="font-bold text-foreground">
                                                    {contact.first_name} {contact.last_name}
                                                </p>
                                                {interconnectedNumbers.has(contact.whatsapp_phone || "") && (
                                                    <span className="flex items-center gap-1 bg-emerald-100 text-emerald-700 text-xs font-black uppercase px-2 py-0.5 rounded-full border border-emerald-200">
                                                        <Check className="w-2.5 h-2.5" /> Interconectado
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-muted-foreground font-medium">
                                                {contact.whatsapp_phone} {contact.email ? `• ${contact.email}` : ""}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="rounded-full text-muted-foreground hover:text-primary"
                                            onClick={() => startEdit(contact)}
                                        >
                                            <Edit2 className="w-4 h-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="rounded-full text-muted-foreground hover:text-destructive"
                                            onClick={() => handleDelete(contact.id)}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="bg-white/50 border border-dashed border-border rounded-3xl p-12 text-center space-y-4">
                                <div className="bg-muted w-16 h-16 rounded-full flex items-center justify-center mx-auto">
                                    <UserPlus className="w-8 h-8 text-muted-foreground" />
                                </div>
                                <div>
                                    <p className="font-bold text-foreground">Aún no tienes contactos</p>
                                    <p className="text-xs text-muted-foreground max-w-[200px] mx-auto">
                                        Agrega a tus amigos y colegas para invitarlos rápidamente a tus reservas.
                                    </p>
                                </div>
                                <Button onClick={() => setIsAdding(true)} variant="outline" className="rounded-2xl font-bold">
                                    Agregar mi primer contacto
                                </Button>
                            </div>
                        )}
                    </div>
                )}

                {/* Legal Info Placeholder (Ley de contactos) */}
                {!isAdding && (
                    <div className="p-6 bg-primary/5 rounded-[2rem] border border-primary/10 space-y-3">
                        <div className="flex items-center gap-2 text-primary">
                            <Shield className="w-5 h-5" />
                            <h3 className="font-black text-sm uppercase tracking-tight">Privacidad y Ley de Contactos</h3>
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground font-medium">
                            En cumplimiento con la normativa de protección de datos, tus contactos solo se utilizan para facilitar el proceso de invitación a mesas reservadas.
                            <strong> Almuerzo.cl no utiliza estos datos para fines comerciales.</strong>
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

