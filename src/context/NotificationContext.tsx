"use client";

import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './AuthContext';
import { toast } from 'react-hot-toast';

interface Notification {
    id: string;
    title: string;
    message: string;
    type: string;
    is_read: boolean;
    created_at: string;
    resource_id?: string;
}

interface NotificationContextType {
    notifications: Notification[];
    unreadCount: number;
    markAsRead: (id: string) => Promise<void>;
    markAllAsRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

// Module-level dedup store (survives StrictMode double-mount and reconnects).
const SEEN: Map<string, number> = (globalThis as any).__alm_pwa_toast_seen ||
    ((globalThis as any).__alm_pwa_toast_seen = new Map<string, number>());
const DEDUP_TTL_MS = 8000;

function shouldFire(key: string): boolean {
    const now = Date.now();
    if (SEEN.size > 200) {
        for (const [k, exp] of SEEN) if (exp < now) SEEN.delete(k);
    }
    const exp = SEEN.get(key);
    if (exp && exp > now) return false;
    SEEN.set(key, now + DEDUP_TTL_MS);
    return true;
}

// Types in the `notifications` inbox table that are ALSO surfaced via the
// domain-table UPDATE subscriptions below. For these we only update the bell
// counter — no toast — to prevent double toasts per status change.
function isDomainEchoedType(rawType: string | undefined | null): boolean {
    if (!rawType) return false;
    const t = rawType.toLowerCase();
    return t.includes('order') || t.includes('takeaway') || t.includes('reservation');
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
    const { user } = useAuth();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);

    const fetchNotifications = async () => {
        if (!user) return;
        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(30);

        if (data) {
            setNotifications(data);
            setUnreadCount(data.filter(n => !n.is_read).length);
        }
    };

    useEffect(() => {
        if (!user) return;

        fetchNotifications();

        // Inbox feed — counter only, no toast for domain-echoed types.
        const notificationsChannel = supabase
            .channel(`user-notifications-${user.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'notifications',
                    filter: `user_id=eq.${user.id}`
                },
                (payload) => {
                    const newNotification = payload.new as Notification;
                    setNotifications(prev => [newNotification, ...prev].slice(0, 30));
                    setUnreadCount(prev => prev + 1);

                    // Skip toast if this is echoing a status change that the
                    // domain-table subscription will toast on its own.
                    if (isDomainEchoedType(newNotification.type)) return;

                    const key = `pwa:notif:${newNotification.id}`;
                    if (!shouldFire(key)) return;

                    toast.success(`${newNotification.title}\n${newNotification.message}`, {
                        id: key,
                        duration: 5000,
                    });
                }
            )
            .subscribe();

        // Takeaway order status changes — single source of toast for order updates.
        const ordersChannel = supabase
            .channel(`user-orders-${user.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'takeaway_orders',
                    filter: `user_id=eq.${user.id}`
                },
                (payload) => {
                    const status = payload.new.status?.toUpperCase();
                    const prevStatus = payload.old?.status?.toUpperCase();
                    if (!status || status === prevStatus) return;

                    const key = `pwa:takeaway:${payload.new.id}:${status}`;
                    if (!shouldFire(key)) return;

                    if (status === 'APROBADA') {
                        toast.success('Tu pedido ha sido aprobado', { id: key, icon: '✅' });
                    } else if (status === 'PREPARANDO') {
                        toast('Tu pedido está siendo preparado', { id: key, icon: '🧑‍🍳' });
                    } else if (status === 'LISTO') {
                        toast.success('Tu pedido está listo para retirar en el local', { id: key, duration: 6000, icon: '🥡' });
                        try {
                            const audio = new Audio('/notification.mp3');
                            audio.play().catch(() => { });
                        } catch (e) { }
                    } else if (status === 'ENTREGADO' || status === 'COMPLETADO') {
                        toast.success('¡Pedido entregado! Disfrútalo', { id: key });
                    } else if (status === 'RECHAZADA' || status === 'CANCELADO') {
                        toast.error('Tu pedido fue rechazado o cancelado', { id: key });
                    }
                }
            )
            .subscribe();

        // Reservation status changes — single source of toast for reservation updates.
        const reservationsChannel = supabase
            .channel(`user-reservations-${user.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'reservations',
                    filter: `organizer_id=eq.${user.id}`
                },
                (payload) => {
                    const status = payload.new.status?.toUpperCase();
                    const prevStatus = payload.old?.status?.toUpperCase();
                    if (!status || status === prevStatus) return;

                    const key = `pwa:reservation:${payload.new.id}:${status}`;
                    if (!shouldFire(key)) return;

                    if (status === 'APROBADA' || status === 'CONFIRMADA') {
                        toast.success('¡Tu reserva ha sido confirmada!', { id: key, icon: '📅' });
                        try {
                            const audio = new Audio('/notification.mp3');
                            audio.play().catch(() => { });
                        } catch (e) { }
                    } else if (status === 'RECHAZADA' || status === 'CANCELADA') {
                        toast.error('Tu reserva fue cancelada o rechazada', { id: key });
                    } else if (status === 'COMPLETADO' || status === 'COMPLETADA') {
                        toast.success('¡Disfruta tu experiencia!', { id: key });
                    }
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(notificationsChannel);
            supabase.removeChannel(ordersChannel);
            supabase.removeChannel(reservationsChannel);
        };
    }, [user]);

    const markAsRead = async (id: string) => {
        const { error } = await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('id', id);

        if (!error) {
            setNotifications(prev =>
                prev.map(n => n.id === id ? { ...n, is_read: true } : n)
            );
            setUnreadCount(prev => Math.max(0, prev - 1));
        }
    };

    const markAllAsRead = async () => {
        if (!user) return;
        const { error } = await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', user.id)
            .eq('is_read', false);

        if (!error) {
            setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
            setUnreadCount(0);
        }
    };

    return (
        <NotificationContext.Provider value={{ notifications, unreadCount, markAsRead, markAllAsRead }}>
            {children}
        </NotificationContext.Provider>
    );
}

export function useNotifications() {
    const context = useContext(NotificationContext);
    if (context === undefined) {
        throw new Error('useNotifications must be used within a NotificationProvider');
    }
    return context;
}
