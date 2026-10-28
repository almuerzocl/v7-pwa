interface AddressComponent {
    long_name: string;
    short_name: string;
    types: string[];
}

/**
 * Builds a short "calle número, comuna" string from Google's address_components,
 * dropping the region (e.g. "Región Metropolitana") and country ("Chile") that
 * formatted_address always appends — redundant in a Chile-only app.
 */
export function formatShortAddress(components: AddressComponent[] | undefined, fallback: string): string {
    if (!components?.length) return fallback;

    const find = (type: string) => components.find((c) => c.types.includes(type))?.long_name;

    const route = find("route");
    const streetNumber = find("street_number");
    // Same priority AddressAutocomplete already uses to detect the comuna.
    const comuna = find("administrative_area_level_3") || find("locality") || find("sublocality");

    const street = [route, streetNumber].filter(Boolean).join(" ");
    const parts = [street, comuna].filter(Boolean);

    return parts.length > 0 ? parts.join(", ") : fallback;
}

/**
 * Best-effort trim of a region/country suffix from an address string we only
 * have as plain text — e.g. profile.default_address read back from the DB,
 * where we don't have Google's address_components to rebuild it from
 * scratch (that's what formatShortAddress does when we do). Needed because
 * addresses saved before this trimming existed are still stored long in the
 * database; this normalizes them for display without a migration.
 */
export function stripRegionAndCountry(address: string): string {
    return address
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !/^regi[oó]n metropolitana/i.test(part) && !/^chile$/i.test(part))
        .join(", ");
}
