"use client";

import { Search, History, TrendingUp, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";

export default function SearchPage() {
    const [query, setQuery] = useState("");

    const recentSearches = ["Sushi Providencia", "Almuerzo cerca", "Promociones", "Liguria"];
    const popularCategories = ["Chilena", "Italiana", "Sushis", "Vegano", "Hamburgesas", "Cafetería"];

    const paymentMethods = ["Efectivo", "Tarjetas bancarias", "Pluxee", "Edenred", "Amipass"];

    return (
        <div className="w-full h-full max-w-lg mx-auto p-4 space-y-8 pb-24">
            <header className="space-y-4">
                <h1 className="text-3xl font-black tracking-tight text-foreground">Buscar</h1>
                <div className="relative group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
                    <Input
                        placeholder="Restaurantes, platos o cocinas..."
                        className="h-14 pl-12 rounded-2xl border-none bg-muted/50 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-primary/20 transition-all font-bold"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </div>
            </header>

            <div className="space-y-6">
                <section className="space-y-4">
                    <div className="flex items-center gap-2 px-1">
                        <History className="w-4 h-4 text-muted-foreground" />
                        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground">Búsquedas recientes</h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {recentSearches.map((s) => (
                            <button key={s} className="px-4 py-2 bg-muted/30 hover:bg-muted rounded-xl text-sm font-bold border border-border/50 transition-colors">
                                {s}
                            </button>
                        ))}
                    </div>
                </section>

                <section className="space-y-4">
                    <div className="flex items-center gap-2 px-1">
                        <TrendingUp className="w-4 h-4 text-muted-foreground" />
                        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground">Categorías populares</h2>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        {popularCategories.map((cat) => (
                            <button key={cat} className="flex items-center justify-between p-4 bg-card border border-border rounded-2xl hover:border-primary/30 transition-all group overflow-hidden relative">
                                <span className="font-bold relative z-10">{cat}</span>
                                <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors relative z-10" />
                            </button>
                        ))}
                    </div>
                </section>

                <section className="space-y-4">
                    <div className="flex items-center gap-2 px-1">
                        <TrendingUp className="w-4 h-4 text-muted-foreground opacity-0" />
                        <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground -ml-6">Filtro por Medios de Pago</h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {paymentMethods.map((pm) => (
                            <button key={pm} className="px-4 py-2 bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100 rounded-xl text-sm font-bold transition-colors">
                                {pm}
                            </button>
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
}
