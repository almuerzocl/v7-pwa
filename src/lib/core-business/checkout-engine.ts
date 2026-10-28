import { UserProfile, OrderStatus, ReservationStatus } from "@/types";
import { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export interface CheckoutContext {
    user: UserProfile;
    restaurantId: string;
    items?: any[];
}

export type ReputationScope = 'reservation' | 'takeaway';

export interface ReputationSummary {
    score: number;
    level: string;
    lastCalculation: string;
}

/**
 * Motor de Checkout Core V5
 * Encapsula las reglas de negocio críticas para transacciones de pedidos y reservas.
 */
export const CheckoutEngine = {
    /**
     * Valida y prepara los datos del cliente asegurando que no se pidan datos redundantes.
     */
    prepareSessionData(profile: UserProfile) {
        return {
            fullName: `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
            contactPhone: profile.phone_number || profile.phone || '',
            email: profile.email,
            isElite: profile.account_type === 'elite'
        };
    },

    /**
     * Asegura un perfil válido incluso si el usuario no tiene entrada en la tabla 'profiles'.
     * Previene definición redundante de objetos de usuario en los componentes.
     */
    getSafeProfile(user: User | null, profile: UserProfile | null): UserProfile {
        if (!user) throw new Error("User required for safe profile mapping");
        
        return profile || {
            id: user.id,
            email: user.email || '',
            first_name: user.user_metadata?.first_name || '',
            last_name: user.user_metadata?.last_name || '',
            phone_number: user.phone || '',
            account_type: 'free',
            total_reservations: 0,
            reservation_reputation: 100,
            role: 'user',
            created_at: new Date().toISOString()
        } as UserProfile;
    },

    /**
     * Reputación vigente del usuario: LEE el valor que calcula la base de datos una vez al día
     * (calculate_daily_reputation, job pg_cron 'reputation-daily-recalc', migración 020).
     * Es la única fuente de verdad — el cliente NO recalcula: % de operaciones cumplidas sobre las
     * resueltas de los últimos 30 días, igual para reservas y pedidos.
     * `scope` elige el ámbito: 'reservation' → reservation_reputation, 'takeaway' → takeaway_reputation.
     */
    async calculateDailyReputation(userId: string, scope: ReputationScope): Promise<ReputationSummary> {
        const column = scope === 'reservation' ? 'reservation_reputation' : 'takeaway_reputation';
        const now = new Date().toISOString();

        const { data, error } = await supabase
            .from('profiles')
            .select(`${column}, account_type`)
            .eq('id', userId)
            .maybeSingle();

        // ELITE vigente: la reputación vale 100 (la real queda intacta en el perfil; la base lo aplica igual en la aprobación).
        const value = (data as Record<string, unknown> | null)?.account_type === 'elite' ? 100 : (data as Record<string, unknown> | null)?.[column];
        if (error || typeof value !== 'number') {
            console.error("Error leyendo reputación:", error);
            return { score: 100, level: 'Neutral', lastCalculation: now };
        }

        const score = Math.min(100, Math.max(0, value));
        let level = 'Bronce';
        if (score > 80) level = 'Oro';
        else if (score > 60) level = 'Plata';

        return { score, level, lastCalculation: now };
    },

    /**
     * Aplica reglas de negocio específicas según el tipo de cuenta (Free vs Elite).
     */
    applyAccountBenefits(context: CheckoutContext) {
        const { user } = context;
        if (user.account_type === 'elite') {
            return {
                priority: 1,
                serviceFee: 0,
                reservationGuarantee: true,
                badge: 'ELITE'
            };
        }
        return {
            priority: 0,
            serviceFee: 500, // Placeholder
            reservationGuarantee: false,
            badge: 'FREE'
        };
    }
};
