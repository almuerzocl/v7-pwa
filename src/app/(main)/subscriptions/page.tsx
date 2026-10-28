"use client";

import { OperationUsage } from "@/components/OperationUsage";
import { useAuth } from "@/context/AuthContext";
import { ArrowLeft, Award, Building2, ShieldAlert, CheckCircle2, Crown, Info, ExternalLink, Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getEliteStatusAction } from "@/app/actions/elite-status-action";
import { ELITE_PRODUCT_URL, type EliteStatus } from "@/lib/elite";

export default function SubscriptionsPage() {
    const { user, profile, isLoading: authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!authLoading && !user) {
            router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        }
    }, [user, authLoading, router, pathname]);
    const [institutions, setInstitutions] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [eliteStatus, setEliteStatus] = useState<EliteStatus | null>(null);

    useEffect(() => {
        if (!user) return;
        let cancelled = false;
        getEliteStatusAction().then(({ status }) => { if (!cancelled) setEliteStatus(status); }).catch(() => {});
        return () => { cancelled = true; };
    }, [user]);

    useEffect(() => {
        if (!user) return;

        const fetchInstitutions = async () => {
            try {
                const { data, error } = await supabase
                    .from('user_institutions')
                    .select('*, discount_institutions(*)')
                    .eq('user_id', user.id);

                if (!error && data) {
                    setInstitutions(data);
                } else {
                    setInstitutions([]);
                }
            } catch (err) {
                console.error(err);
                setInstitutions([]);
            } finally {
                setLoading(false);
            }
        };

        fetchInstitutions();
    }, [user]);

    if (authLoading || !user) return null;

    // La base decide por fechas (is_elite); si no se pudo leer, se usa la caché del perfil.
    const isElite = eliteStatus ? eliteStatus.active : profile?.account_type === 'elite';
    const endsAtLabel = eliteStatus?.endsAt
        ? new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(eliteStatus.endsAt))
        : null;

    return (
        <div className="w-full min-h-screen bg-slate-50 pb-24">
            <header className="sticky top-0 bg-white/80 backdrop-blur-xl z-50 border-b border-slate-100 p-4">
                <div className="max-w-md mx-auto flex items-center gap-4">
                    <Button variant="ghost" size="icon" onClick={() => router.back()} className="rounded-2xl bg-slate-100/50 hover:bg-slate-100 transition-colors shrink-0">
                        <ArrowLeft className="w-5 h-5 text-slate-600" />
                    </Button>
                    <div>
                        <h1 className="text-lg font-black tracking-tight text-slate-900 leading-none">Instituciones y Beneficios</h1>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Convenios y Descuentos</p>
                    </div>
                </div>
            </header>

            <main className="max-w-md mx-auto p-4 space-y-8">
                {/* Account Tier Hero */}
                <div className={`rounded-[2.5rem] p-8 text-white relative overflow-hidden transition-all duration-500 shadow-2xl ${isElite ? 'bg-gradient-to-br from-slate-900 via-indigo-950 to-indigo-900 shadow-indigo-500/20' : 'bg-gradient-to-br from-indigo-700 to-indigo-500 shadow-indigo-500/10'}`}>
                    <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
                        {isElite ? <Crown className="w-48 h-48 -mr-12 -mt-12 rotate-12" /> : <Award className="w-48 h-48 -mr-12 -mt-12 rotate-12" />}
                    </div>
                    <div className="relative z-10 space-y-6">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-white/15 rounded-full border border-white/20 backdrop-blur-md">
                            {isElite ? <Crown className="w-3 h-3 text-yellow-400" /> : <Award className="w-3 h-3 text-white/80" />}
                            <span className="text-[10px] uppercase font-black tracking-[0.2em] text-white">Nivel de Miembro</span>
                        </div>
                        <div className="space-y-1">
                            <h2 className="text-4xl font-black tracking-tighter uppercase leading-none">
                                {isElite ? 'Elite' : 'Digital'}
                            </h2>
                            <p className="text-sm font-medium text-white/70 leading-relaxed uppercase tracking-wider">
                                {isElite ? 'Suscripción Premium Activa' : 'Cuenta Gratuita'}
                            </p>
                        </div>
                        {!isElite ? (
                            <div className="space-y-4 pt-2">
                                <ul className="space-y-2">
                                    <li className="flex items-center gap-2 text-[11px] font-bold text-white/90">
                                        <CheckCircle2 className="w-3.5 h-3.5 text-indigo-300" /> Operaciones sin límite (la cuenta gratuita tiene tope diario y semanal)
                                    </li>
                                    <li className="flex items-center gap-2 text-[11px] font-bold text-white/90">
                                        <CheckCircle2 className="w-3.5 h-3.5 text-indigo-300" /> Reputación en 100 % mientras tu cuenta sea Elite
                                    </li>
                                    <li className="flex items-center gap-2 text-[11px] font-bold text-white/90">
                                        <CheckCircle2 className="w-3.5 h-3.5 text-indigo-300" /> Una sola cuenta puede organizar reservas y pedidos para otras personas
                                    </li>
                                </ul>
                                {eliteStatus?.pending ? (
                                    <p className="rounded-2xl bg-white/15 px-4 py-3 text-xs font-bold text-white" role="status">
                                        Recibimos tu compra de Elite: se activa en unos minutos.
                                    </p>
                                ) : (
                                    <>
                                        <Button asChild className="w-full bg-white text-indigo-900 hover:bg-slate-50 rounded-2xl h-14 font-black shadow-lg shadow-black/10 text-base">
                                            <a href={ELITE_PRODUCT_URL} target="_blank" rel="noopener noreferrer">Subir a Elite</a>
                                        </Button>
                                        {user.email && (
                                            <p className="text-[11px] font-bold text-white/80">
                                                Compra con este mismo correo: <span className="break-all">{user.email}</span>. La cuenta Elite se usa con un solo correo.
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>
                        ) : (
                            <div className="pt-2">
                                <p className="text-xs font-bold text-indigo-200">Disfrutas de beneficios ilimitados en toda la red Almuerzo.</p>
                                {endsAtLabel && <p className="mt-1 text-xs font-bold text-indigo-200">Vigente hasta el {endsAtLabel}.</p>}
                            </div>
                        )}
                    </div>
                </div>

                <OperationUsage />

                {/* Institutions Section */}
                <div className="space-y-4">
                    <div className="flex items-center justify-between px-1">
                        <h3 className="font-black text-xl tracking-tight text-slate-800">Mis Instituciones</h3>
                        <div className="bg-slate-200/50 px-2.5 py-1 rounded-full text-[10px] font-black text-slate-500 uppercase">
                            {institutions.length} Activas
                        </div>
                    </div>

                    {loading ? (
                        <div className="flex flex-col items-center py-10 space-y-4">
                            <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Sincronizando beneficios...</p>
                        </div>
                    ) : institutions.length > 0 ? (
                        <div className="grid gap-4">
                            {institutions.map((rel: any) => (
                                <BenefitCard key={rel.institution_id} institution={rel.discount_institutions} />
                            ))}
                        </div>
                    ) : (
                        <div className="p-10 text-center space-y-6 bg-white rounded-[2.5rem] border border-dashed border-slate-200 flex flex-col items-center shadow-sm">
                            <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center border border-slate-100">
                                <ShieldAlert className="w-8 h-8 text-slate-300" />
                            </div>
                            <div className="space-y-1">
                                <p className="text-base text-slate-800 font-black">Sin instituciones asociadas</p>
                                <p className="text-xs text-slate-400 font-medium max-w-[200px] leading-tight">
                                    Vincula tu empresa o institución para acceder a descuentos directos.
                                </p>
                            </div>
                            <Button variant="outline" onClick={() => router.push('/profile/discount-clubs')} className="rounded-2xl border-2 font-bold h-12 px-8">
                                Vincular Institución
                            </Button>
                        </div>
                    )}
                </div>

                {/* Discovery */}
                <div onClick={() => router.push('/profile/discount-clubs')} className="bg-indigo-50/50 rounded-[2rem] p-6 border border-indigo-100 flex items-center gap-4 group cursor-pointer hover:bg-indigo-50 transition-colors">
                    <div className="bg-white p-3 rounded-2xl shadow-sm group-hover:scale-110 transition-transform">
                        <Search className="w-6 h-6 text-indigo-600" />
                    </div>
                    <div className="flex-1">
                        <h4 className="font-black text-slate-800 text-sm">Explorar Convenios</h4>
                        <p className="text-[11px] text-slate-500 font-medium leading-tight">Ver todas las instituciones con beneficios activos.</p>
                    </div>
                    <ExternalLink className="w-4 h-4 text-slate-300" />
                </div>
            </main>
        </div>
    );
}

function BenefitCard({ institution }: { institution: any }) {
    return (
        <div className="p-5 bg-white border border-slate-100 rounded-[2rem] flex items-center justify-between shadow-sm hover:border-indigo-500/30 transition-all group hover:shadow-md cursor-pointer">
            <div className="flex items-center gap-4">
                <div className="h-14 w-14 bg-indigo-50 rounded-2xl flex items-center justify-center group-hover:bg-indigo-600 transition-colors duration-300 overflow-hidden shrink-0">
                    {institution?.logo_url ? (
                        <img src={institution.logo_url} alt={institution.name} className="w-full h-full object-cover" />
                    ) : (
                        <Building2 className="w-7 h-7 text-indigo-600 group-hover:text-white transition-colors" />
                    )}
                </div>
                <div className="space-y-1">
                    <h4 className="font-black text-slate-800 text-sm group-hover:text-indigo-600 transition-colors">{institution?.name || 'Institución'}</h4>
                    {institution?.rules && (
                        <p className="text-[11px] font-medium text-slate-400 leading-tight line-clamp-2 max-w-[200px]">{institution.rules}</p>
                    )}
                    <div className={`inline-flex px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-tighter ${institution?.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        {institution?.is_active ? 'Activo' : 'Inactivo'}
                    </div>
                </div>
            </div>
            <Button variant="ghost" size="icon" className="rounded-full bg-slate-50 group-hover:bg-indigo-50 group-hover:text-indigo-600 shrink-0">
                <Info className="w-4 h-4" />
            </Button>
        </div>
    );
}
