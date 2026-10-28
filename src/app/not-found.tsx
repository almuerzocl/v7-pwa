import Link from 'next/link';

export default function NotFound() {
    return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center bg-zinc-50">
            <h1 className="text-6xl font-black text-zinc-900">404</h1>
            <p className="text-lg font-bold text-zinc-500 mt-4">Página no encontrada</p>
            <p className="text-sm text-zinc-400 mt-2">La página que buscas no existe o fue movida.</p>
            <Link href="/" className="mt-8 px-8 py-3 bg-zinc-900 text-white rounded-2xl font-bold text-sm hover:bg-zinc-800 transition-all">
                Volver al inicio
            </Link>
        </div>
    );
}
