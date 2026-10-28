"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin, X, CheckCircle2 } from "lucide-react";
import { usePlacesWidget } from "react-google-autocomplete";
import { cn } from "@/lib/utils";
import { formatShortAddress } from "@/lib/address-format";

// Gran Santiago. Default: only a ranking bias. With `strictSantiago`: a hard limit.
const SANTIAGO_BOUNDS = { north: -33.0, south: -33.8, east: -70.3, west: -71.0 };
const NOT_FOUND_MESSAGE = "No encontramos esa dirección en el Gran Santiago. Elige una de la lista.";

const isRegionMetropolitana = (components: any[] | undefined) =>
    !!components?.some((c) =>
        c.types.includes("administrative_area_level_1") && /metropolitana/i.test(c.long_name)
    );

interface AddressAutocompleteProps {
    onAddressSelect: (address: {
        address: string;
        lat: number;
        lng: number;
        commune?: string;
    }) => void;
    placeholder?: string;
    className?: string;
    defaultValue?: string;
    /**
     * Header location selector mode. Suggests streets, comunas, neighborhoods and known
     * places (no type filter, not only exact numbered addresses), limited strictly to
     * Gran Santiago.
     * Enter picks the first suggestion, and text that was never geocoded is rejected
     * with a message (the restaurant list depends on lat/lng). Off by default so the
     * profile and onboarding forms keep their current behavior.
     */
    strictSantiago?: boolean;
    autoFocus?: boolean;
}

export function AddressAutocomplete({
    onAddressSelect,
    placeholder = "Busca tu calle y número...",
    className,
    defaultValue = "",
    strictSantiago = false,
    autoFocus = false,
}: AddressAutocompleteProps) {
    const [inputValue, setInputValue] = useState(defaultValue);
    const [isFocused, setIsFocused] = useState(false);
    const [isConfirmed, setIsConfirmed] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        setInputValue(defaultValue);
        setIsConfirmed(!!defaultValue);
    }, [defaultValue]);

    const { ref } = usePlacesWidget<HTMLInputElement>({
        apiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
        onPlaceSelected: (place) => {
            if (!place?.geometry?.location) {
                // Enter/blur on free text: Google returns only { name } with no geometry.
                if (strictSantiago) setError(NOT_FOUND_MESSAGE);
                return;
            }
            if (strictSantiago && !isRegionMetropolitana(place.address_components)) {
                setError(NOT_FOUND_MESSAGE);
                return;
            }
            setError("");

            const lat = place.geometry.location.lat();
            const lng = place.geometry.location.lng();
            const fullAddress = place.formatted_address || place.name || inputValue;
            let address = formatShortAddress(place.address_components, fullAddress);
            // A known place without a street (a plaza, a landmark) would collapse to just
            // its comuna: keep its name, "Plaza Italia, Providencia".
            if (strictSantiago && place.name && place.address_components
                && !place.address_components.some((c: any) => c.types.includes("route"))
                && !address.toLowerCase().startsWith(place.name.toLowerCase())) {
                address = [place.name, address].filter(Boolean).join(", ");
            }

            let commune = "";
            if (place.address_components) {
                const comp = place.address_components.find((c: any) =>
                    c.types.includes("administrative_area_level_3") ||
                    c.types.includes("locality")
                );
                if (comp) commune = comp.long_name;
            }

            setInputValue(address);
            setIsConfirmed(true);
            onAddressSelect({ address, lat, lng, commune });
        },
        options: {
            // [] = no type filter (addresses, comunas, neighborhoods AND known places).
            // Not `undefined`: usePlacesWidget would default it to ["(cities)"].
            types: strictSantiago ? [] : ["address"],
            componentRestrictions: { country: "cl" },
            bounds: SANTIAGO_BOUNDS,
            ...(strictSantiago ? { strictBounds: true } : {}),
            fields: ["address_components", "geometry", "formatted_address", "name"],
            language: "es",
        },
    });

    useEffect(() => {
        if (autoFocus) ref.current?.focus();
    }, [autoFocus, ref]);

    // Enter without a highlighted suggestion does nothing in Google's widget: pick the
    // first suggestion instead. Capture phase so it runs before Google's own handler.
    useEffect(() => {
        const input = ref.current;
        if (!strictSantiago || !input) return;

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Enter" || !input.value.trim()) return;
            const hasSuggestions = Array.from(document.querySelectorAll<HTMLElement>(".pac-container"))
                .some((c) => getComputedStyle(c).display !== "none" && c.querySelector(".pac-item"));
            if (!hasSuggestions) {
                e.preventDefault();
                setError(NOT_FOUND_MESSAGE);
                return;
            }
            if (!document.querySelector(".pac-item-selected")) {
                // Google ignores Enter when no suggestion is highlighted. Hold this Enter
                // back, highlight the first suggestion with a real ArrowDown keydown and
                // replay Enter: same autocomplete session, so no extra billing. (Clicking
                // the item or google.maps.event.trigger did not make Google emit the place.)
                e.preventDefault();
                e.stopImmediatePropagation();
                const press = (key: string, code: number) =>
                    input.dispatchEvent(new KeyboardEvent("keydown", {
                        key, keyCode: code, which: code, bubbles: true, cancelable: true,
                    }));
                press("ArrowDown", 40);
                setTimeout(() => press("Enter", 13), 50);
            }
        };
        input.addEventListener("keydown", onKeyDown, true);
        return () => input.removeEventListener("keydown", onKeyDown, true);
    }, [strictSantiago, ref]);

    return (
        <div className={cn("w-full", className)}>
            <div className="relative w-full group">
                <div className={cn(
                    "absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 transition-colors z-10 pointer-events-none",
                    isConfirmed ? "text-emerald-500" : isFocused ? "text-primary" : "text-muted-foreground"
                )}>
                    {isConfirmed ? <CheckCircle2 className="w-full h-full" /> : <MapPin className="w-full h-full" />}
                </div>

                <input
                    ref={ref}
                    type="text"
                    value={inputValue}
                    onChange={(e) => {
                        setInputValue(e.target.value);
                        if (isConfirmed) setIsConfirmed(false);
                        if (error) setError("");
                    }}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    placeholder={placeholder}
                    autoComplete="off"
                    enterKeyHint={strictSantiago ? "go" : undefined}
                    aria-invalid={!!error}
                    className={cn(
                        "flex h-14 w-full rounded-2xl pl-12 pr-10 py-2 text-base font-bold transition-all outline-none",
                        "bg-muted/50 border border-transparent placeholder:text-muted-foreground/50",
                        "focus:bg-background focus:border-primary/20 focus:ring-4 focus:ring-primary/10",
                        isConfirmed && "border-emerald-200 bg-emerald-50/50",
                        error && "border-destructive/40 bg-destructive/5"
                    )}
                />

                {inputValue && (
                    <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                            setInputValue("");
                            setIsConfirmed(false);
                            setError("");
                            if (ref.current) ref.current.focus();
                        }}
                        className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground/40 hover:text-muted-foreground transition-colors z-10"
                    >
                        <X className="w-full h-full" />
                    </button>
                )}
            </div>

            {error && (
                <p role="alert" className="mt-2 ml-1 text-xs font-semibold text-destructive">
                    {error}
                </p>
            )}
        </div>
    );
}
