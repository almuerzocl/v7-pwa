"use client";

import { createContext, useContext, useState, ReactNode } from "react";

interface LocationState {
    address: string;
    lat: number | null;
    lng: number | null;
}

interface LocationContextType extends LocationState {
    setLocation: (address: string, lat: number | null, lng: number | null) => void;
}

const DEFAULT_STATE: LocationState = { address: "Santiago, Chile", lat: null, lng: null };

const LocationContext = createContext<LocationContextType>({
    ...DEFAULT_STATE,
    setLocation: () => {},
});

export function LocationProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<LocationState>(DEFAULT_STATE);

    const setLocation = (address: string, lat: number | null, lng: number | null) => {
        setState({ address, lat, lng });
    };

    return (
        <LocationContext.Provider value={{ ...state, setLocation }}>
            {children}
        </LocationContext.Provider>
    );
}

export const useLocation = () => useContext(LocationContext);
