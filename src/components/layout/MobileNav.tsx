"use client";

import { Home, ShoppingBag, CalendarRange, ClipboardList } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCart } from "@/context/CartContext";

// Barra inferior por tareas: descubrir, mis reservas, mis pedidos y carrito.
// Mi cuenta (foto) y las alertas (campana) viven en el encabezado.
export function MobileNav() {
    const pathname  = usePathname();
    const { itemCount } = useCart();

    const navItems = [
        { name: "Inicio",   href: "/",             icon: Home },
        { name: "Reservas", href: "/reservations", icon: CalendarRange },
        { name: "Pedidos",  href: "/orders",       icon: ClipboardList },
        { name: "Carrito",  href: "/cart",         icon: ShoppingBag, badge: itemCount },
    ];

    return (
        <div className="fixed bottom-0 left-0 z-[20000] w-full h-[68px] sm:h-16 bg-background/95 backdrop-blur border-t border-border pb-safe">
            <nav aria-label="Navegación principal" className="grid h-full max-w-lg grid-cols-4 mx-auto font-medium">
                {navItems.map((item) => {
                    const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                    const Icon = item.icon;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                            className={`inline-flex flex-col items-center justify-center hover:bg-muted group ${
                                isActive ? "text-primary" : "text-muted-foreground"
                            }`}
                        >
                            <div className="relative">
                                <Icon className={`w-[22px] h-[22px] mb-1 ${
                                    isActive ? "text-primary fill-primary/10" : "text-muted-foreground group-hover:text-primary/80"
                                }`} />
                                {!!item.badge && item.badge > 0 && (
                                    <span className="absolute -top-1 -right-2 bg-primary text-white text-xs font-bold min-w-[16px] h-[16px] rounded-full flex items-center justify-center border border-background px-0.5">
                                        {item.badge}
                                    </span>
                                )}
                            </div>
                            <span className={`text-xs tracking-tight ${
                                isActive ? "text-primary font-bold" : "text-muted-foreground font-medium group-hover:text-primary/80"
                            }`}>
                                {item.name}
                            </span>
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
