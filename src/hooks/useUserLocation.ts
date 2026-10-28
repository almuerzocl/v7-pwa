"use client";

import { useState, useEffect } from "react";

interface UserLocation {
    lat: number;
    lng: number;
}

export interface UseUserLocationResult {
    location: UserLocation | null;
    /** True when the user has explicitly denied location permission, or the device has no GPS. */
    denied: boolean;
    /** True while the initial permission prompt / lookup is still pending. */
    loading: boolean;
}

export function useUserLocation(): UseUserLocationResult {
    const [location, setLocation] = useState<UserLocation | null>(null);
    const [denied, setDenied] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!navigator?.geolocation) {
            setDenied(true);
            setLoading(false);
            return;
        }

        navigator.geolocation.getCurrentPosition(
            pos => {
                setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                setLoading(false);
            },
            (err) => {
                // code 1 = PERMISSION_DENIED; also treat POSITION_UNAVAILABLE / TIMEOUT as denied
                setDenied(true);
                setLoading(false);
            },
            { timeout: 8000, maximumAge: 5 * 60 * 1000 }
        );
    }, []);

    return { location, denied, loading };
}

// Haversine distance in meters between two lat/lng points
export function haversineMeters(
    lat1: number, lng1: number,
    lat2: number, lng2: number
): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Walking speed ~5 km/h → 83.3 m/min
export function walkingMinutes(meters: number): number {
    return Math.max(1, Math.round(meters / 83.3));
}

export function formatDistance(meters: number): string {
    if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
    return `${(meters / 1000).toFixed(1)} km`;
}
