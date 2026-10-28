import Link from 'next/link';

export const metadata = {
    title: 'Política de Privacidad | Almuerzo.cl',
};

const mail = <a href="mailto:quiero@almuerzo.cl" className="text-orange-500 font-bold hover:underline">quiero@almuerzo.cl</a>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="space-y-3">
            <h2 className="text-lg font-black text-zinc-900">{title}</h2>
            {children}
        </section>
    );
}

function List({ items }: { items: React.ReactNode[] }) {
    return (
        <ul className="list-disc pl-5 space-y-1">
            {items.map((it, i) => <li key={i}>{it}</li>)}
        </ul>
    );
}

export default function PrivacidadPage() {
    return (
        <div className="min-h-screen bg-zinc-50 py-16 px-6">
            <div className="max-w-2xl mx-auto space-y-8">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-black tracking-tight text-zinc-900">Política de Privacidad</h1>
                    <p className="text-sm text-zinc-500 font-bold">Almuerzo.cl — Última actualización: 25 de octubre de 2026</p>
                </div>

                <div className="bg-white rounded-3xl border border-zinc-100 p-8 sm:p-10 space-y-6 text-sm text-zinc-700 leading-relaxed shadow-sm">
                    <Section title="1. Quiénes somos">
                        <p>Almuerzo.cl es operado por <strong>Saborez SpA</strong>, RUT 77.078.389-5, con domicilio en Almirante Pastene 185, oficina 607, Providencia, Santiago, Chile. Somos el responsable de tus datos personales. Contacto: {mail}.</p>
                        <p>Esta política cubre la <strong>tienda web</strong> (almuerzo.cl, donde los restaurantes compran planes), la <strong>aplicación para comensales</strong> (app2.almuerzo.cl) y el <strong>panel de restaurantes</strong> (rest2.almuerzo.cl).</p>
                    </Section>

                    <Section title="2. Qué datos tratamos, para qué y con qué base">
                        <p className="font-bold text-zinc-900">Tienda web (compra de planes por restaurantes)</p>
                        <List items={[
                            <><strong>Datos de compra:</strong> nombre, correo, teléfono y dirección de facturación. Para procesar la compra y contactarte por ella (ejecución del contrato).</>,
                            <><strong>Datos tributarios:</strong> RUT, razón social, giro, dirección tributaria, nombre de fantasía del local y correo para documentos tributarios. Para emitir documentos, identificar tu local y activar el plan (contrato y obligación legal).</>,
                            <><strong>Registro del plan:</strong> fechas y duración de cada período contratado.</>,
                            <><strong>Pagos:</strong> los procesan Shopify y sus proveedores de pago; Almuerzo.cl no ve ni guarda los datos de tu tarjeta.</>,
                        ]} />
                        <p className="font-bold text-zinc-900">Aplicación para comensales</p>
                        <List items={[
                            <><strong>Cuenta:</strong> nombre, apellido, correo, teléfono (opcional) y foto de perfil si entras con Google. Para crear y proteger tu cuenta (contrato).</>,
                            <><strong>Reservas:</strong> restaurante, fecha, hora, cantidad de personas y solicitudes especiales (contrato).</>,
                            <><strong>Pedidos para retirar:</strong> productos, monto, hora de retiro, y el nombre y teléfono del pedido (contrato).</>,
                            <><strong>Invitados:</strong> nombre y correo de las personas que agregas a una reserva, para enviarles la invitación y el ticket. Tú declaras que tienes derecho a compartir esos datos (ver sección 5).</>,
                            <><strong>Contactos guardados:</strong> nombre, correo y WhatsApp, para agregarlos rápido a tus reservas. Comparamos esos teléfonos con las cuentas existentes para mostrarte cuáles ya usan Almuerzo.cl.</>,
                            <><strong>Reputación como comensal:</strong> se calcula con tus reservas y pedidos cumplidos y no cumplidos de los últimos 30 días (ver sección 8). Base: interés legítimo en que el servicio funcione para todos y en limitar abusos.</>,
                            <><strong>Ubicación:</strong> la dirección que escribes (con autocompletado de Google Maps) o tu ubicación GPS si das el permiso en tu dispositivo, y la dirección por defecto si decides guardarla. Para mostrarte locales cercanos. Puedes negar el permiso y usar la app igual.</>,
                            <><strong>Descuentos:</strong> instituciones o convenios a los que te asocias, para aplicarte descuentos.</>,
                            <><strong>Uso de la app:</strong> qué locales te aparecen, cuáles abres, si miras su carta, los compartes o los llamas, si empiezas un pedido o una reserva; cuándo abres la app, desde qué tipo de dispositivo y si la tienes instalada; los pasos de una reserva o pedido y si alguno falla; favoritos y suscripciones al menú del día; y errores técnicos. <strong>No guardamos lo que escribes</strong>: ni búsquedas, ni direcciones, ni nombres. Se asocian a tu cuenta y se guardan en detalle por 30 días; después solo quedan totales diarios que no te identifican. Los ve el equipo de Almuerzo.cl; los restaurantes solo ven cifras agregadas. Base: interés legítimo en mejorar el servicio.</>,
                            <><strong>Correos del servicio:</strong> confirmaciones, invitaciones, recordatorios, rechazos y cierres de pedido. Guardamos un registro de que se envió, con el correo destinatario, para evitar duplicados.</>,
                            <><strong>OlivIA (asistente de almuerzo):</strong> el texto que escribes, la conversación de esa sesión, los locales y platos que más pediste o reservaste en los últimos 90 días (solo nombres y cuántas veces, sin montos) y, si lo compartes o eliges una dirección, la distancia a cada local se envían a Anthropic para generar la recomendación. No incluimos tu nombre, correo ni teléfono, y no guardamos lo que escribes: solo registramos cuántas consultas haces (3 por día) y su costo. Para considerar el clima consultamos el pronóstico de Santiago a Open-Meteo, que solo recibe las coordenadas de la ciudad. Por eso, evita escribir datos personales en tus consultas.</>,
                        ]} />
                        <p className="font-bold text-zinc-900">Panel de restaurantes</p>
                        <List items={[
                            <>Datos del personal del local (nombre, correo, rol) y del local (nombre, dirección, horarios, menú e imágenes).</>,
                        ]} />
                    </Section>

                    <Section title="3. Qué ve cada restaurante de ti">
                        <p>Un restaurante ve el nombre, la cantidad de personas, la hora y las solicitudes de tus reservas, y los datos de tus pedidos, <strong>solo en su local</strong>. Además recibe estadísticas agregadas de la actividad en su local (cuántas personas lo vieron, abrieron su carta o lo guardaron como favorito); nunca ve quién fue.</p>
                    </Section>

                    <Section title="4. Con quién compartimos datos">
                        <List items={[
                            <><strong>Shopify:</strong> tienda web, pagos y facturación de planes.</>,
                            <><strong>Supabase:</strong> base de datos y autenticación.</>,
                            <><strong>Google Cloud:</strong> alojamiento de las aplicaciones.</>,
                            <><strong>Google Maps:</strong> autocompletado de direcciones.</>,
                            <><strong>Google Analytics:</strong> medición de visitas, solo si aceptas las cookies analíticas.</>,
                            <><strong>Resend:</strong> envío de correos.</>,
                            <><strong>Anthropic:</strong> genera las recomendaciones de OlivIA.</>,
                            <><strong>Open-Meteo:</strong> pronóstico del tiempo de Santiago para las recomendaciones de OlivIA (no recibe datos tuyos).</>,
                        ]} />
                        <p>No vendemos tus datos ni los usamos para publicidad de terceros. Podemos entregar datos si una autoridad competente lo exige por ley.</p>
                    </Section>

                    <Section title="5. Datos de invitados y de terceros">
                        <p>Si agregas a alguien como invitado, nos entregas su nombre y correo para que reciba la invitación; hazlo solo si esa persona te lo permite. Si recibiste una invitación y no quieres que tengamos tus datos, escríbenos a {mail}. Los tickets públicos muestran los datos enmascarados.</p>
                    </Section>

                    <Section title="6. Transferencias internacionales">
                        <p>Algunos de nuestros proveedores (Shopify, Supabase, Google, Resend, Anthropic) pueden tratar datos fuera de Chile, principalmente en Estados Unidos. Trabajamos con proveedores que aplican medidas de seguridad contractuales y técnicas.</p>
                    </Section>

                    <Section title="7. Cuánto tiempo guardamos los datos">
                        <List items={[
                            <>Eventos de uso de la app (detalle): <strong>30 días</strong>; después solo totales diarios que no te identifican.</>,
                            <>Registros de acceso a tickets públicos: 25 horas.</>,
                            <>Consultas a OlivIA (fecha, cantidad y costo, sin el texto): 90 días.</>,
                            <>Cuenta, reservas, pedidos y reputación: mientras tu cuenta esté activa y hasta 12 meses después de que la cierres.</>,
                            <>Registro de correos enviados: 12 meses.</>,
                            <>Datos tributarios y de compras de planes: 6 años, el plazo que exige la normativa tributaria.</>,
                        ]} />
                    </Section>

                    <Section title="8. Reputación y decisiones automáticas">
                        <p>Tu reputación (de 0 a 100) se calcula automáticamente: reservas y pedidos cumplidos ÷ (cumplidos + no cumplidos) de los últimos 30 días; es 100 si aún no tienes operaciones resueltas. Según los criterios de cada restaurante, tu solicitud puede aprobarse al instante o quedar para revisión manual del local. Si no estás de acuerdo con una decisión, puedes pedir que una persona la revise escribiendo a {mail}.</p>
                    </Section>

                    <Section title="9. Tus derechos">
                        <p>Puedes pedirnos acceso a tus datos, rectificarlos, eliminarlos u oponerte a su tratamiento, y retirar tu consentimiento cuando sea la base. Aplicamos la Ley N° 19.628 y, desde que entre en vigencia, la Ley N° 21.719, que amplía estos derechos. Escríbenos a {mail}; respondemos lo antes posible y a más tardar en 30 días corridos. Hoy la eliminación de cuenta se solicita por ese correo. También puedes reclamar ante la autoridad de protección de datos que corresponda.</p>
                    </Section>

                    <Section title="10. Cookies y almacenamiento local">
                        <p>Usamos cookies esenciales (sesión, carrito) y almacenamiento local (preferencias y tu elección de cookies). Google Analytics solo se carga si aceptas las cookies analíticas en el aviso; si las rechazas o no eliges, no se carga. Más detalle en la <Link href="/cookies" className="text-orange-500 font-bold hover:underline">Política de Cookies</Link>.</p>
                    </Section>

                    <Section title="11. Seguridad">
                        <List items={[
                            'Cifrado en tránsito (HTTPS/TLS) en toda la plataforma.',
                            'Autenticación segura y acceso restringido a los datos de cada local.',
                            'Enmascaramiento de datos personales en tickets públicos.',
                        ]} />
                        <p>Ningún sistema es infalible. Si ocurre un incidente que afecte tus datos, te avisaremos como corresponda.</p>
                    </Section>

                    <Section title="12. Menores y cambios">
                        <p>La plataforma es para mayores de 18 años. Si cambiamos esta política, publicaremos la nueva versión con su fecha.</p>
                    </Section>
                </div>

                <div className="text-center">
                    <Link href="/" className="text-sm font-bold text-orange-500 hover:underline">
                        Volver al inicio
                    </Link>
                </div>
            </div>
        </div>
    );
}
