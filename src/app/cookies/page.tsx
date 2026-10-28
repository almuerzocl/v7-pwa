import Link from 'next/link';

export const dynamic = 'force-static';

export const metadata = {
    title: 'Política de Cookies | Almuerzo.cl',
};

export default function CookiesPage() {
    return (
        <div className="min-h-screen bg-zinc-50 py-16 px-6">
            <div className="max-w-2xl mx-auto space-y-8">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-black tracking-tight text-zinc-900">Política de Cookies</h1>
                    <p className="text-sm text-zinc-500 font-bold">Almuerzo.cl — Última actualización: 25 de octubre de 2026</p>
                </div>

                <div className="bg-white rounded-3xl border border-zinc-100 p-8 sm:p-10 space-y-5 text-sm text-zinc-700 leading-relaxed shadow-sm">
                    <p>Almuerzo.cl utiliza cookies y tecnologías similares (almacenamiento local) para ofrecer, proteger y mejorar su servicio. Esta política explica qué son y cómo las usamos.</p>

                    <section className="space-y-2">
                        <h2 className="text-base font-black text-zinc-900">Cookies esenciales</h2>
                        <p>Son necesarias para el funcionamiento del sitio: inicio de sesión, carrito, preferencias y seguridad. También guardamos en tu navegador tu elección de cookies. Sin ellas la Plataforma no puede operar y no requieren consentimiento.</p>
                    </section>

                    <section className="space-y-2">
                        <h2 className="text-base font-black text-zinc-900">Cookies analíticas (opcionales)</h2>
                        <p>Usamos Google Analytics para entender cómo se usa la Plataforma y mejorarla. Solo se carga si aceptas las cookies opcionales en el aviso; si las rechazas o no eliges, no se carga. Puedes cambiar tu decisión borrando los datos del sitio en tu navegador, y el aviso volverá a aparecer.</p>
                    </section>

                    <section className="space-y-2">
                        <h2 className="text-base font-black text-zinc-900">Cómo gestionarlas</h2>
                        <p>Puedes aceptar o rechazar las cookies opcionales al ingresar. Además, puedes eliminarlas en cualquier momento desde la configuración de tu navegador. Ten en cuenta que deshabilitar cookies esenciales afectará el funcionamiento del sitio.</p>
                    </section>

                    <p>Más información en nuestra <Link href="/privacidad" className="text-orange-600 font-bold">Política de Privacidad</Link> o escribe a <a className="text-orange-600 font-bold" href="mailto:quiero@almuerzo.cl">quiero@almuerzo.cl</a>.</p>
                </div>

                <div className="text-center">
                    <Link href="/" className="text-sm font-bold text-zinc-500 hover:text-zinc-900">Volver al inicio</Link>
                </div>
            </div>
        </div>
    );
}
