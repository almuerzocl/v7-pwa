// Core Business Logic Engine Exports
export { checkCapacity, type ServiceType } from './availability';
export { loadEligibleDiscounts, formatDiscountAmount, buildDiscountNote, DISCOUNTS_UNAVAILABLE_MESSAGE, type InstitutionDiscount } from './discounts';
export { matchExistingUser } from './guests';
export { getOpeningShiftsForDay, dayIndexForDateStr, type RestaurantShift } from './restaurant-hours';

