"use client";

import { useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { ArrowLeft, Smartphone, Mail, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter, usePathname } from "next/navigation";

export default function NotificationsPage() {
    const { user, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!authLoading && !user) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        }
    }, [user, authLoading, router, pathname]);

    if (authLoading || !user) return null;

    return (
        <div className="w-full min-h-screen bg-slate-50 pb-24">
            <header className="sticky top-0 bg-white/80 backdrop-blur-xl z-50 border-b border-slate-100 p-4 flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => router.back()} className="rounded-2xl bg-slate-100/50 hover:bg-slate-100">
                    <ArrowLeft className="w-5 h-5 text-slate-600" />
                </Button>
                <div>
                    <h1 className="text-lg font-black tracking-tight text-slate-900 leading-none">Notificaciones</h1>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Canales y Alertas</p>
                </div>
            </header>

            <main className="max-w-md mx-auto p-4">
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="bg-white rounded-[2.5rem] p-8 space-y-4 border border-slate-100 shadow-sm">
                        <h3 className="text-xl font-black text-slate-800 tracking-tight">Canales de Alerta</h3>
                        <p className="text-sm text-slate-400 font-medium leading-relaxed">
                            Estamos trabajando para integrar más canales de comunicación. Por ahora, todas las alertas se registran en tu cuenta Almuerzo.cl.
                        </p>

                        <div className="pt-4 space-y-3">
                            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl">
                                <div className="flex items-center gap-3">
                                    <Smartphone className="w-5 h-5 text-slate-400" />
                                    <span className="text-sm font-bold text-slate-600">App</span>
                                </div>
                                <span className="text-[8px] font-black bg-slate-200 px-2 py-1 rounded text-slate-500 uppercase">Configurado</span>
                            </div>
                            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl">
                                <div className="flex items-center gap-3">
                                    <Mail className="w-5 h-5 text-slate-400" />
                                    <span className="text-sm font-bold text-slate-600">Email</span>
                                </div>
                                <span className="text-[8px] font-black bg-emerald-100 px-2 py-1 rounded text-emerald-600 uppercase">Activo</span>
                            </div>
                            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl">
                                <div className="flex items-center gap-3">
                                    <MessageCircle className="w-5 h-5 text-slate-400" />
                                    <span className="text-sm font-bold text-slate-600">WhatsApp</span>
                                </div>
                                <span className="text-[8px] font-black bg-amber-100 px-2 py-1 rounded text-amber-600 uppercase">Próximamente</span>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
