"use client";

import { useState, useEffect, useRef } from "react";
import { trackPlatformEvent } from "@/lib/platform-events";
import { MapPin, ChevronDown, Navigation, X, Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLocation } from "@/context/LocationContext";
import { supabase } from "@/lib/supabase";
import { AddressAutocomplete } from "@/components/ui/AddressAutocomplete";
import { formatShortAddress, stripRegionAndCountry } from "@/lib/address-format";

async function reverseGeocode(lat: number, lng: number): Promise<string> {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    try {
        const res = await fetch(
            `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&language=es&region=CL`
        );
        const data = await res.json();
        if (data.status === "OK" && data.results?.length > 0) {
            // Prefer a street-level result; fall back to the first result
            const street = data.results.find((r: any) =>
                r.types.some((t: string) => ["street_address", "premise", "route"].includes(t))
            );
            const result = street || data.results[0];
            return formatShortAddress(result.address_components, result.formatted_address);
        }
        // Falling back to raw coordinates — log why so this is diagnosable from
        // prod devtools instead of silently showing "-33.4372, -70.6506".
        console.error("[LocationSelector] reverse geocode returned no usable result:", data.status, data.error_message);
    } catch (e) {
        console.error("[LocationSelector] reverse geocode failed:", e);
    }
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

export function LocationSelector() {
    const { profile, user, isLoading } = useAuth();
    const { address, setLocation } = useLocation();
    const [isOpen, setIsOpen] = useState(false);
    const [locating, setLocating] = useState(false);
    const autoLocateAttempted = useRef(false);

    useEffect(() => {
        if (profile?.default_address) {
            // profile.default_address may still hold the long form saved before
            // short addresses existed — trim it here too, not just on write.
            setLocation(stripRegionAndCountry(profile.default_address), profile.default_address_lat ?? null, profile.default_address_lng ?? null);
            return;
        }

        // No saved address yet — detect it once auth has settled, so the header
        // (and anything reading the shared location, like the home feed's
        // distance filter) shows the user's real approximate address instead of
        // the "Santiago, Chile" placeholder. Silent no-op if permission is
        // denied/unavailable; the user can still set it manually via the panel
        // below — that's the only way to change it away from what was detected.
        if (isLoading || autoLocateAttempted.current || !navigator?.geolocation) return;
        autoLocateAttempted.current = true;
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                const { latitude: lat, longitude: lng } = pos.coords;
                setLocation(await reverseGeocode(lat, lng), lat, lng);
                trackPlatformEvent("location_set", { props: { source: "gps_auto" } });
            },
            () => { /* denied or unavailable — keep the placeholder */ },
            { timeout: 10000 }
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile, isLoading]);

    // Single path for both ways of choosing a location (typed address and GPS):
    // update the shared session location, close the panel and persist to the profile.
    const applyLocation = async (newAddress: string, lat: number, lng: number) => {
        setLocation(newAddress, lat, lng);
        setIsOpen(false);

        if (!user) return;
        const { error } = await supabase.from('profiles').update({
            default_address: newAddress,
            default_address_lat: lat,
            default_address_lng: lng,
        }).eq('id', user.id);
        if (error) console.error("[LocationSelector] could not save default address:", error.message);
    };

    const handleAddressSelect = (addr: { address: string; lat: number; lng: number }) => {
        trackPlatformEvent("location_set", { props: { source: "manual" } });
        return applyLocation(addr.address, addr.lat, addr.lng);
    };

    const handleUseCurrentLocation = () => {
        if (!navigator?.geolocation) return;
        setLocating(true);
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                const { latitude: lat, longitude: lng } = pos.coords;
                const humanAddress = await reverseGeocode(lat, lng);
                setLocating(false);
                trackPlatformEvent("location_set", { props: { source: "gps" } });
                await applyLocation(humanAddress, lat, lng);
            },
            () => setLocating(false),
            { timeout: 10000 }
        );
    };

    return (
        <>
            <button
                onClick={() => setIsOpen(true)}
                className="flex flex-col flex-1 truncate items-start text-left outline-none group"
            >
                <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase flex items-center gap-1 group-hover:text-primary transition-colors">
                    <MapPin className="w-3 h-3 text-primary" /> Quiero buscar en la dirección
                </span>
                <div className="flex items-center gap-1 w-full">
                    <span className="text-sm font-bold truncate text-foreground group-hover:text-primary transition-colors">
                        {address}
                    </span>
                    <ChevronDown className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                </div>
            </button>

            {/* Overlay panel — not a Dialog, so no focus trap blocking PAC dropdown */}
            {isOpen && (
                <div className="fixed inset-0 z-[9000]" onClick={() => setIsOpen(false)}>
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
                    <div
                        className="absolute top-0 left-0 right-0 bg-background rounded-b-3xl p-6 pt-[max(1.5rem,env(safe-area-inset-top))] space-y-4 shadow-2xl animate-in slide-in-from-top-4 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-black tracking-tight">Cambiar ubicación</h2>
                            <button onClick={() => setIsOpen(false)} className="p-2 rounded-xl hover:bg-muted transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Empty and focused so the user types the new place; the current one is only a reference. */}
                        <AddressAutocomplete
                            strictSantiago
                            autoFocus
                            onAddressSelect={handleAddressSelect}
                            placeholder="Busca una calle, comuna o sector de Santiago"
                        />
                        <p className="text-xs text-muted-foreground px-1">
                            Ubicación actual: <span className="font-semibold text-foreground">{address}</span>
                        </p>

                        <button
                            disabled={locating}
                            onClick={handleUseCurrentLocation}
                            className="w-full h-12 flex items-center justify-start gap-3 px-4 rounded-xl border border-dashed border-primary/30 hover:bg-primary/5 hover:border-primary/50 text-muted-foreground hover:text-primary transition-all font-semibold text-sm disabled:opacity-50"
                        >
                            {locating
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : <Navigation className="w-4 h-4" />
                            }
                            {locating ? "Obteniendo ubicación..." : "Usar mi ubicación actual"}
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
