import { Skeleton } from "@/components/ui/skeleton";
import { Utensils, Calendar, MapPin, Search } from 'lucide-react';

export default function Loading() {
  return (
    <div className="w-full h-full max-w-lg mx-auto p-4 space-y-6 pb-24 animate-in fade-in duration-500">
      {/* Header Bar Skeleton */}
      <div className="bg-card border border-border/50 rounded-3xl p-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-primary/5 p-2.5 rounded-2xl">
            <MapPin className="w-5 h-5 text-muted-foreground/30" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-2 w-20" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </div>

      {/* View Selector Skeleton */}
      <div className="flex bg-muted/50 rounded-2xl p-1 gap-1 border border-border/50">
        <div className="flex-1 py-3 bg-background rounded-xl flex items-center justify-center gap-2">
           <Utensils className="w-4 h-4 text-primary opacity-20" />
           <Skeleton className="h-4 w-12" />
        </div>
        <div className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2">
           <Calendar className="w-4 h-4 text-muted-foreground opacity-20" />
           <Skeleton className="h-4 w-12" />
        </div>
      </div>

      <div className="space-y-4">
        {/* Search Bar Skeleton */}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/30" />
          <div className="w-full h-14 bg-muted/20 border-2 border-transparent rounded-[1.5rem]" />
        </div>

        {/* Filters Skeleton */}
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-2xl shrink-0" />
          ))}
        </div>

        <div className="space-y-2 px-1">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>

      {/* Content List Skeleton */}
      <div className="flex flex-col gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2 p-3 bg-card rounded-3xl border border-border/60">
            <Skeleton className="h-40 w-full rounded-2xl" />
            <div className="space-y-3 mt-4 px-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <div className="flex justify-between items-center pt-2">
                <div className="flex gap-2">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <Skeleton className="h-6 w-12 rounded-lg" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
