'use client';

import { useOfflineSync } from '@/hooks/useOfflineSync';

export function OfflineSyncProvider({ children }: { children: React.ReactNode }) {
    useOfflineSync();
    return <>{children}</>;
}
