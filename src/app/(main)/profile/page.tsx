"use client";

import { useAuth } from "@/context/AuthContext";
import { LogOut, ChevronRight, UserCircle, Heart, CalendarRange, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { OperationUsage } from "@/components/OperationUsage";
import { getInitials } from "@/lib/core-business/ui-helpers";

export default function MiCuentaPage() {
    const { user, profile } = useAuth();
    const router = useRouter();

    const initials = getInitials(profile?.first_name, profile?.last_name);

    const favCount  = profile?.favorite_restaurant_ids?.length || 0;
    const subsCount = profile?.subscribed_daily_menu_ids?.length || 0;
    const favDesc   = [
        favCount  ? `${favCount} favorito${favCount  !== 1 ? "s" : ""}` : null,
        subsCount ? `${subsCount} suscripción${subsCount !== 1 ? "es" : ""}` : null,
    ].filter(Boolean).join(" · ") || "Favoritos y alertas de menú";

    const menuItems = [
        { label: "Mis Reservas",                  icon: CalendarRange, desc: "Historial y gestión de reservas",        href: "/reservations" },
        { label: "Mis Pedidos",                   icon: ShoppingBag,   desc: "Historial y seguimiento de pedidos",     href: "/orders" },
        { label: "Mis Favoritos y Suscripciones", icon: Heart,         desc: favDesc,                                  href: "/favorites" },
        { label: "Agenda de Contactos",           icon: UserCircle,    desc: "Mis invitados y lista de contactos",       href: "/profile/contacts" },
        { label: "Mis Datos y Seguridad",         icon: UserCircle,    desc: "Nombre, teléfono, dirección, clubes y contraseña", href: "/profile/info" },
    ];

    return (
        <div className="w-full max-w-lg mx-auto p-4 space-y-8 pb-24">
            <h1 className="text-2xl font-black tracking-tight text-foreground pt-1">Mi Cuenta</h1>

            {/* Header / Hero */}
            <div className="flex flex-col items-center text-center space-y-4 pt-6">
                <div className="h-24 w-24 rounded-full bg-primary/10 border-4 border-background shadow-xl flex items-center justify-center relative overflow-hidden ring-2 ring-primary/20">
                    {profile?.photo_url ? (
                        <img src={profile.photo_url} alt="Profile" className="w-full h-full object-cover" />
                    ) : (
                        <span className="text-3xl font-black text-primary">{initials}</span>
                    )}
                </div>
                <div className="space-y-1">
                    <h2 className="text-2xl font-black tracking-tight text-foreground">
                        {profile?.first_name ? `${profile.first_name} ${profile.last_name || ""}` : "Usuario Almuerzo"}
                    </h2>
                    {profile?.display_name && (
                        <p className="text-sm font-bold text-primary">@{profile.display_name}</p>
                    )}
                    <p className="text-sm text-muted-foreground font-medium">{user?.email}</p>
                </div>

            </div>

            <OperationUsage />

            {/* Menu List */}
            <div className="space-y-3">
                {menuItems.map((item, idx) => {
                    const Icon = item.icon;
                    return (
                        <Link
                            key={idx}
                            href={item.href || '#'}
                            className="w-full p-4 flex items-center justify-between bg-card border border-border rounded-3xl hover:border-primary/30 hover:shadow-md transition-all group active:scale-[0.99]"
                        >
                            <div className="flex items-center gap-4 text-left">
                                <div className="bg-muted p-2.5 rounded-2xl group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                                    <Icon className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="font-bold text-foreground group-hover:text-primary transition-colors">{item.label}</p>
                                    <p className="text-xs text-muted-foreground font-medium">{item.desc}</p>
                                </div>
                            </div>
                            <ChevronRight className="w-5 h-5 text-muted-foreground" />
                        </Link>
                    );
                })}
            </div>

            {/* Sign Out Section — server-side signOut guarantees cookie clear + redirect */}
            <div className="pt-4">
                <form action="/auth/signout" method="post">
                    <Button
                        type="submit"
                        variant="ghost"
                        className="w-full h-14 rounded-2xl text-destructive hover:text-destructive hover:bg-destructive/5 font-bold gap-3 border border-transparent hover:border-destructive/20"
                    >
                        <LogOut className="w-5 h-5" />
                        Cerrar Sesión
                    </Button>
                </form>
            </div>

            <p className="text-center text-xs text-muted-foreground font-bold uppercase tracking-[0.2em]">
                Almuerzo Cloud Core V5.0.1
            </p>
        </div>
    );
}
