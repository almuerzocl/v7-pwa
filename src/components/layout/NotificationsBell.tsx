"use client";

import { Bell, Calendar, Utensils } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useNotifications } from "@/context/NotificationContext";

export function NotificationsBell() {
    const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications();
    const [showNotifications, setShowNotifications] = useState(false);

    return (
        <>
            {/* Notification panel */}
            {showNotifications && typeof document !== "undefined" && createPortal(
                <>
                    <div className="fixed inset-0 z-[19999]" onClick={() => setShowNotifications(false)} />
                    <div className="fixed top-[calc(4rem+env(safe-area-inset-top,0px))] left-0 right-0 z-[20000] mx-auto w-full max-w-lg px-3 pt-2 animate-in slide-in-from-top-2">
                        <div className="bg-white rounded-2xl shadow-xl border border-border/50 max-h-[60vh] overflow-y-auto p-2">
                            <div className="flex items-center justify-between p-2 mb-1">
                                <h3 className="font-bold text-sm">Notificaciones</h3>
                                {unreadCount > 0 && (
                                    <button
                                        onClick={() => markAllAsRead()}
                                        className="text-xs text-primary font-bold uppercase hover:text-primary/70 transition-colors"
                                    >
                                        Marcar leídas
                                    </button>
                                )}
                            </div>
                            <div className="space-y-1">
                                {notifications.length === 0 ? (
                                    <div className="text-center py-6 text-muted-foreground">
                                        <Bell className="w-8 h-8 mx-auto mb-2 opacity-20" />
                                        <p className="text-xs font-medium">No tienes notificaciones</p>
                                    </div>
                                ) : (
                                    notifications.map(notification => (
                                        <div
                                            key={notification.id}
                                            onClick={() => !notification.is_read && markAsRead(notification.id)}
                                            className={`p-3 rounded-xl transition-colors cursor-pointer ${
                                                !notification.is_read ? "bg-primary/5" : "hover:bg-muted/50"
                                            }`}
                                        >
                                            <div className="flex gap-3">
                                                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                                                    !notification.is_read ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                                                }`}>
                                                    {notification.type === "reservation"
                                                        ? <Calendar className="w-4 h-4" />
                                                        : <Utensils className="w-4 h-4" />}
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className={`text-xs font-bold ${!notification.is_read ? "text-foreground" : "text-muted-foreground"}`}>
                                                        {notification.title}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground leading-snug">{notification.message}</p>
                                                    <p className="text-xs text-muted-foreground/70 uppercase font-bold tracking-wider pt-0.5">
                                                        {notification.created_at
                                                            ? format(new Date(notification.created_at), "dd MMM HH:mm", { locale: es })
                                                            : "Ahora"}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </>
            
            , document.body)}

            <button
                type="button"
                onClick={() => setShowNotifications(!showNotifications)}
                aria-expanded={showNotifications}
                aria-label={unreadCount > 0 ? `Alertas, ${unreadCount} sin leer` : "Alertas"}
                className="relative h-11 w-11 shrink-0 rounded-full flex items-center justify-center hover:bg-muted"
            >
                <Bell className={`w-[22px] h-[22px] ${showNotifications ? "text-primary fill-primary/10" : "text-muted-foreground"}`} aria-hidden="true" />
                {unreadCount > 0 && (
                    <span className="absolute top-0.5 right-0.5 bg-red-500 text-white text-xs font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center border border-background px-0.5">
                        {unreadCount}
                    </span>
                )}
            </button>
        </>
    );
}
