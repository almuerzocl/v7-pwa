import { UserProfile, UserRole } from "@/types";

/**
 * Skill: Role-Based Access Control (RBAC)
 * Centralized utility for checking permissions across the PWA and Dashboard.
 * All comparisons are CASE-INSENSITIVE to ensure robust access control.
 */

/**
 * Checks if the profile has any of the specified roles.
 */
export function hasRole(profile: UserProfile | null | undefined, roles: UserRole | UserRole[]): boolean {
    if (!profile || !profile.role) return false;
    
    const allowedRoles = Array.isArray(roles) ? roles : [roles];
    const userRole = profile.role.toLowerCase();
    
    return allowedRoles.some(role => role.toLowerCase() === userRole);
}

/**
 * Checks if the user is a Super Admin.
 */
export function isSuperAdmin(profile: UserProfile | null | undefined): boolean {
    return hasRole(profile, 'SUPER_ADMIN');
}

/**
 * Checks if the user has General Admin privileges (Top-level management).
 */
export function isAdmin(profile: UserProfile | null | undefined): boolean {
    return hasRole(profile, ['ADMIN', 'SUPER_ADMIN', 'OWNER', 'RESTAURANT_ADMIN', 'ADMINISTRADOR']);
}

/**
 * Checks if the user can manage reservations.
 */
export function canViewReservations(profile: UserProfile | null | undefined): boolean {
    return isAdmin(profile) || hasRole(profile, ['OPERATIONS_MANAGER', 'RESERVATION_MANAGER', 'RESERVAS']);
}

/**
 * Checks if the user can manage takeaway orders.
 */
export function canViewTakeaway(profile: UserProfile | null | undefined): boolean {
    return isAdmin(profile) || hasRole(profile, ['OPERATIONS_MANAGER', 'TAKEAWAY_MANAGER', 'PEDIDOS']);
}

/**
 * Checks if the user can manage the menu.
 */
export function canViewMenu(profile: UserProfile | null | undefined): boolean {
    return isAdmin(profile) || hasRole(profile, ['OPERATIONS_MANAGER', 'MENU_MANAGER', 'MENU']);
}

/**
 * Checks if the user can view account/settings.
 */
export function canViewSettings(profile: UserProfile | null | undefined): boolean {
    return isAdmin(profile);
}

/**
 * Checks if the user can manage a specific restaurant.
 * A user can manage if they are a Super Admin or if they are an Admin for that specific restaurant.
 */
export function canManageRestaurant(profile: UserProfile | null | undefined, restaurantId: string): boolean {
    if (!profile) return false;
    if (isSuperAdmin(profile)) return true;
    
    return isAdmin(profile) && profile.restaurant_id === restaurantId;
}

/**
 * Checks if the user can perform administrative actions globally.
 */
export function canPerformAdminActions(profile: UserProfile | null | undefined): boolean {
    return isAdmin(profile);
}
