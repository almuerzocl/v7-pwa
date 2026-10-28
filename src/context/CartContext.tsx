"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { useAuth } from "./AuthContext";
import { keyOf, type SelectedOption } from "@/lib/cart-lines";

const CART_KEY    = "almuerzo-cart";
const CART_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface CartItem {
    id: string;
    name: string;
    price: number;
    quantity: number;
    imageUrl?: string;
    restaurantId: string;
    restaurantName: string;
    /** Clave de línea (plato + opciones). Sin ella la línea se identifica por el id del plato (carritos antiguos). */
    lineKey?: string;
    /** Precio base del plato; `price` es el precio unitario FINAL (base + recargos de las opciones). */
    basePrice?: number;
    options?: SelectedOption[];
}

interface CartContextType {
    items: CartItem[];
    addToCart: (item: CartItem) => void;
    removeFromCart: (id: string) => void;
    updateQuantity: (id: string, quantity: number) => void;
    clearCart: () => void;
    /** Reemplaza las líneas (p. ej. con los precios corregidos que devolvió el servidor). */
    replaceItems: (items: CartItem[]) => void;
    total: number;
    itemCount: number;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children }: { children: React.ReactNode }) {
    const [items, setItems] = useState<CartItem[]>([]);
    const { user } = useAuth();

    // Load cart on mount — discard if older than 30 minutes
    useEffect(() => {
        try {
            const raw = localStorage.getItem(CART_KEY);
            if (!raw) return;

            const parsed = JSON.parse(raw);

            // Legacy format: bare array saved before TTL was introduced → treat as expired
            if (Array.isArray(parsed)) {
                localStorage.removeItem(CART_KEY);
                return;
            }

            const { items: savedItems, savedAt } = parsed as { items: CartItem[]; savedAt: number };
            const expired = !savedAt || (Date.now() - savedAt) > CART_TTL_MS;

            if (expired) {
                localStorage.removeItem(CART_KEY);
                console.log("[Cart] Carrito expirado (>30 min) — limpiado automáticamente.");
            } else if (Array.isArray(savedItems)) {
                setItems(savedItems);
            }
        } catch (e) {
            console.error("[Cart] Error al cargar carrito:", e);
            localStorage.removeItem(CART_KEY);
        }
    }, [user]);

    // Persist cart with a fresh timestamp on every change
    useEffect(() => {
        localStorage.setItem(CART_KEY, JSON.stringify({ items, savedAt: Date.now() }));
    }, [items]);

    const addToCart = (newItem: CartItem) => {
        setItems(prev => {
            const fromDifferentRestaurant = prev.length > 0 && prev[0].restaurantId !== newItem.restaurantId;
            const base = fromDifferentRestaurant ? [] : prev;
            const existing = base.find(i => keyOf(i) === keyOf(newItem));
            if (existing) {
                return base.map(i => keyOf(i) === keyOf(newItem) ? { ...i, quantity: i.quantity + Math.max(1, newItem.quantity || 1) } : i);
            }
            return [...base, newItem];
        });
    };

    const removeFromCart = (id: string) => {
        setItems(prev => prev.filter(i => keyOf(i) !== id));
    };

    const updateQuantity = (id: string, quantity: number) => {
        if (quantity <= 0) {
            removeFromCart(id);
            return;
        }
        setItems(prev => prev.map(i => keyOf(i) === id ? { ...i, quantity } : i));
    };

    const clearCart = () => setItems([]);
    const replaceItems = (next: CartItem[]) => setItems(next);

    const total = items.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    const itemCount = items.reduce((acc, item) => acc + item.quantity, 0);

    return (
        <CartContext.Provider value={{ items, addToCart, removeFromCart, updateQuantity, clearCart, replaceItems, total, itemCount }}>
            {children}
        </CartContext.Provider>
    );
}

export function useCart() {
    const context = useContext(CartContext);
    if (context === undefined) {
        throw new Error("useCart must be used within a CartProvider");
    }
    return context;
}
