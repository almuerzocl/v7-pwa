import Link from 'next/link';

export default function Footer() {
    return (
        <footer className="border-t border-zinc-100 bg-white">
            <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-zinc-500">
                <p className="font-bold">
                    © {new Date().getFullYear()} Almuerzo.cl · Desarrollado por{' '}
                    <a href="https://www.saborez.cl" className="hover:text-zinc-900 underline">Saborez</a>
                </p>
                <nav aria-label="Legal" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                    <Link href="/terminos" className="hover:text-zinc-900 font-bold">Términos</Link>
                    <Link href="/privacidad" className="hover:text-zinc-900 font-bold">Privacidad</Link>
                    <Link href="/cookies" className="hover:text-zinc-900 font-bold">Cookies</Link>
                    <a href="mailto:soporte@almuerzo.cl" className="hover:text-zinc-900 font-bold">Ayuda</a>
                    <a href="mailto:quiero@almuerzo.cl" className="hover:text-zinc-900 font-bold">Contacto</a>
                </nav>
            </div>
        </footer>
    );
}
