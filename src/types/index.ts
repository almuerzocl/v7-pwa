// Core Data Models for Almuerzo V5

export interface Restaurant {
    id: string;
    name: string;
    description: string;
    phone: string;
    address: {
        street: string;
        number: string;
        additional?: string;
        commune: string;
    };
    location: any;
    image_url: string;
    logo_url?: string;
    cover_image_url?: string;
    cuisine_type: string;
    capacity: number;
    spaces: string[];
    space_capacities: Record<string, number>;
    opening_hours: Array<{
        day: string;
        hours: string;
    }>;
    rating: {
        google: number;
        opinions: number;
    };
    payment_methods: string[];
    is_sponsored: boolean;
    is_featured: boolean;
    is_active: boolean;
    is_new: boolean;
    price_level: number;
    price_range: string;
    comuna: string;
    has_takeaway: boolean;
    has_reservations: boolean;
    available_services: string[]; // ["para servir", "para llevar"]
    service_rules: any;
    average_prep_time: number;
    slot_duration: number;
    billing_plan: string;
    user_limit: number;
    last_menu_sent_at?: string;
    created_at: string;
    updated_at: string;
}

export interface MenuItem {
    id: string;
    restaurant_id: string;
    name: string;
    description?: string;
    price: number;
    category: string;
    image_url?: string;
    item_type: 'permanent' | 'temporary';
    is_available: boolean;
    is_available_for_takeaway?: boolean;
    takeaway_price?: number;
    is_menu_del_dia?: boolean;
    preparation_time?: number;
    created_at: string;
}

export interface UserProfile {
    id: string;
    email: string;
    first_name?: string;
    last_name?: string;
    display_name?: string;
    photo_url?: string;
    phone?: string;
    phone_number?: string;
    role: UserRole;
    restaurant_id?: string;
    reservation_reputation?: number;
    total_reservations?: number;
    takeaway_reputation?: number;
    total_takeaway_orders?: number;
    account_type: 'free' | 'elite';
    onboarding_completed?: boolean;
    default_address?: string;
    default_address_lat?: number;
    default_address_lng?: number;
    favorite_restaurant_ids?: string[];
    subscribed_daily_menu_ids?: string[];
    preferred_payment_methods?: string[];
    created_at: string;
}

export interface Contact {
    id: string;
    owner_id: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    whatsapp_phone?: string;
    avatar_url?: string;
    created_at?: string;
}

export type OrderStatus = 'PENDIENTE' | 'RECHAZADA' | 'APROBADA' | 'PREPARANDO' | 'LISTO' | 'COMPLETADO' | 'CANCELADO' | 'NO_RETIRADO';
export type ReservationStatus = 'CREADA' | 'PENDIENTE' | 'CONFIRMADA' | 'CHECK-IN CLIENTE' | 'COMPLETADO' | 'CANCELADA' | 'RECHAZADA' | 'NO_SHOW';
export type UserRole = 
    | 'USER' 
    | 'ADMIN' 
    | 'SUPER_ADMIN' 
    | 'OWNER' 
    | 'RESTAURANT_ADMIN' 
    | 'OPERATIONS_MANAGER' 
    | 'RESERVATION_MANAGER' 
    | 'TAKEAWAY_MANAGER' 
    | 'MENU_MANAGER'
    | 'RESERVAS' 
    | 'PEDIDOS' 
    | 'MENU'
    | 'ADMINISTRADOR'
    | string; // Support for extensible roles

export interface Reservation {
    id: string;
    organizer_id: string;
    restaurant_id: string;
    title?: string;
    date_time: string;
    status: ReservationStatus;
    guests: Array<{
        id?: string;
        contact_id?: string;
        name: string;
        email?: string;
        phone?: string;
        is_organizer: boolean;
        status: string;
        selected_discount?: any;
        user_id?: string;
    }>;
    guest_ids: string[];
    guest_data?: any[]; // Snapshot of guest details (JSONB in DB) - Aligned with V5 Final
    party_size: number;
    payment_method?: string;
    special_requests?: string;
    unique_code?: string;
    
    // Almuerzo V5 Snapshots (Critical for business logic persistence)
    organizer_reputation_snapshot?: number;
    user_total_reservations_snapshot?: number;
    account_type_snapshot?: string;
    benefits_snapshot?: any;
    discount_data_snapshot?: any;
    applied_discount_id?: string;
    
    // Status and Metadata
    validated_by_user?: boolean;
    validated_by_restaurant?: boolean;
    timestamps: {
        created_at: string;
        received_at?: string;
        confirmed_at?: string;
        arrived_at?: string;
        [key: string]: any;
    };
    created_at: string;
}

export interface TakeawayOrder {
    id: string;
    user_id: string;
    restaurant_id: string;
    items: any[];
    total_amount: number;
    status: OrderStatus;
    customer_name: string;
    customer_phone: string;
    
    // Almuerzo V5 Snapshots
    user_reputation_snapshot?: number;
    account_type_snapshot?: string;
    benefits_snapshot?: any;
    metadata?: {
        source: string;
        reputation_level?: string;
        [key: string]: any;
    };
    
    // Timestamps for lifecycle
    timestamps?: {
        created_at?: string;
        approved_at?: string;
        ready_at?: string;
        completed_at?: string;
        [key: string]: any;
    };
    approved_at?: string;
    confirmed_at?: string;
    rejected_at?: string;
    created_at: string;
}

/**
 * UI-specific representation of a Restaurant for display in cards and lists.
 * Consumes snake_case data from DB and provides camelCase for the frontend.
 */
export interface RestaurantData {
    id: string;
    name: string;
    description: string;
    logoUrl?: string;
    coverImageUrl?: string;
    cuisineType: string;
    priceLevel: number;
    address: string;
    comuna: string;
    phoneNumber?: string;
    hasReservations: boolean;
    hasTakeaway: boolean;
    averagePrepTimeMinutes?: number;
    isSponsored: boolean;
    isFeatured: boolean;
    isActive: boolean;
    dailyMenus?: any[];
    lat?: number;
    lng?: number;
}
