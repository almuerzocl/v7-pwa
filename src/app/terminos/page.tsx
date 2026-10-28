import Link from 'next/link';

export const dynamic = 'force-static';

export const metadata = {
    title: 'Términos y Condiciones | Almuerzo.cl',
};

const mail = <a className="text-orange-600 font-bold" href="mailto:quiero@almuerzo.cl">quiero@almuerzo.cl</a>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="space-y-2">
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

export default function TerminosPage() {
    return (
        <div className="min-h-screen bg-zinc-50 py-16 px-6">
            <div className="max-w-2xl mx-auto space-y-8">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-black tracking-tight text-zinc-900">Términos y Condiciones</h1>
                    <p className="text-sm text-zinc-500 font-bold">Almuerzo.cl — Última actualización: 25 de octubre de 2026</p>
                </div>

                <div className="bg-white rounded-3xl border border-zinc-100 p-8 sm:p-10 space-y-6 text-sm text-zinc-700 leading-relaxed shadow-sm">
                    <Section title="1. Quiénes somos y qué es Almuerzo.cl">
                        <p>Almuerzo.cl (la &quot;Plataforma&quot;) es operada por <strong>Saborez SpA</strong>, RUT 77.078.389-5, Almirante Pastene 185, oficina 607, Providencia, Santiago. Al usarla aceptas estos términos. Tiene dos públicos: <strong>comensales</strong>, que reservan mesa y piden para retirar, y <strong>restaurantes</strong>, que contratan un plan para recibir reservas y pedidos.</p>
                        <p>Somos un intermediario tecnológico. No cocinamos, no vendemos la comida ni la entregamos: la comida, su calidad, su precio y el horario de atención son del restaurante.</p>
                    </Section>

                    <Section title="2. Cuenta">
                        <p>Debes tener 18 años o más, dar datos verdaderos y cuidar tu clave. Eres responsable de lo que se haga con tu cuenta; avísanos de inmediato si detectas un uso no autorizado.</p>
                    </Section>

                    <Section title="3. Reservas">
                        <List items={[
                            'Una reserva puede quedar pendiente, confirmada o rechazada. Se confirma cuando el restaurante la aprueba o cuando se aprueba sola según los criterios del local.',
                            'Te enviamos el correo de confirmación y las invitaciones solo cuando la reserva está confirmada. Si el restaurante la rechaza, te avisamos.',
                            'Una vez confirmada, solo tú puedes cancelarla.',
                            'Cancelar hasta 1 hora antes de la hora reservada no tiene consecuencias. Cancelar con menos de 1 hora, o no llegar, cuenta como reserva no cumplida.',
                            'Si el restaurante no responde una reserva pendiente antes de que termine el día, se cancela sin penalizarte.',
                        ]} />
                    </Section>

                    <Section title="4. Pedidos para retirar">
                        <List items={[
                            'Puedes cancelar tu pedido sin consecuencias mientras no esté en preparación. Si ya está en preparación o listo y lo cancelas, o no lo retiras, cuenta como pedido no cumplido.',
                            'Si el restaurante no responde un pedido pendiente, o nunca llegó a prepararlo, se cancela sin penalizarte.',
                            'Tu pedido puede ser rechazado por el restaurante, por ejemplo por falta de stock o cierre imprevisto; en ese caso te avisamos.',
                        ]} />
                    </Section>

                    <Section title="5. Pago de la comida">
                        <p><strong>El pago de la comida se hace en el local. Almuerzo.cl no cobra ni procesa ese pago</strong> ni guarda datos de tu tarjeta. Cualquier reclamo por el cobro, la boleta o el precio se resuelve con el restaurante.</p>
                    </Section>

                    <Section title="6. Reputación">
                        <p>Calculamos tu reputación con tus operaciones de los últimos 30 días: cumplidas ÷ (cumplidas + no cumplidas), de 0 a 100, y 100 si aún no tienes operaciones resueltas. Las cancelaciones a tiempo, los rechazos y lo que esté en curso no cuentan. Cada restaurante puede fijar un mínimo para aprobar tu solicitud automáticamente; si no lo alcanzas, el local la revisa a mano.</p>
                    </Section>

                    <Section title="7. Límites de la cuenta gratuita">
                        <p>La cuenta gratuita permite hasta <strong>2 operaciones por día y 10 por semana</strong> (semana de lunes a domingo, hora de Chile). Cuentan las reservas y pedidos que haces tú, incluidas las que luego cancelas; no cuentan los rechazos ni las cancelaciones que hacen el restaurante o el sistema. Las cuentas Elite tienen condiciones especiales, que se informan al contratarlas.</p>
                    </Section>

                    <Section title="8. Invitados">
                        <p>Si invitas a alguien nos entregas su nombre y correo, y declaras que puedes hacerlo. Eres el organizador y respondes por tu reserva.</p>
                    </Section>

                    <Section title="9. Uso aceptable">
                        <p>Queda prohibido: (a) hacer reservas o pedidos falsos o suplantar a otras personas; (b) automatizar el uso con bots o scrapers sin autorización; (c) burlar los límites de la cuenta o la reputación; (d) interferir con el funcionamiento o la seguridad de la Plataforma; (e) publicar contenido ofensivo, difamatorio o ilícito. Podemos limitar o suspender las cuentas que lo hagan.</p>
                    </Section>

                    <Section title="10. Para restaurantes">
                        <List items={[
                            'Los planes se compran en la tienda web (Shopify). Cada unidad comprada es un período de 30 días; si compras más de una, los períodos se suman uno tras otro. Cada plan incluye un número de usuarios y un tope de operaciones por período, según el plan contratado.',
                            'Para identificar tu local usamos tu RUT y el nombre de fantasía que indicas al comprar; debe ser el mismo en cada compra.',
                            'Cuando el local no tiene un período vigente, puede dejar de recibir nuevas reservas y pedidos hasta que lo tenga.',
                            'Eres responsable de la información de tu local, de la comida, del servicio y de atender las reservas y pedidos que confirmas.',
                            'Los reembolsos y cambios de planes se rigen por la política de reembolso de la tienda.',
                            'Nos autorizas a mostrar el nombre, logo, fotos y menú de tu local en la Plataforma.',
                        ]} />
                    </Section>

                    <Section title="11. Propiedad intelectual">
                        <p>Las marcas, el diseño, los textos y el software de la Plataforma son de Saborez SpA o de sus licenciantes y están protegidos por la legislación chilena e internacional. No se concede licencia para reproducirlos sin autorización escrita.</p>
                    </Section>

                    <Section title="12. Responsabilidad">
                        <p>La Plataforma se entrega &quot;tal cual&quot; y no garantizamos disponibilidad ininterrumpida ni ausencia de errores. No respondemos por la calidad de la comida ni por el cumplimiento del restaurante, ni por daños indirectos o lucro cesante, en la medida que la ley lo permita y sin afectar tus derechos como consumidor (Ley N° 19.496).</p>
                    </Section>

                    <Section title="13. Datos personales y cambios">
                        <p>El tratamiento de tus datos se rige por nuestra <Link href="/privacidad" className="text-orange-600 font-bold">Política de Privacidad</Link>. Podemos actualizar estos términos y publicaremos la fecha de la última versión.</p>
                    </Section>

                    <Section title="14. Ley aplicable y contacto">
                        <p>Estos términos se rigen por las leyes de Chile. Las controversias se someterán a los tribunales ordinarios de Santiago, sin perjuicio de los derechos irrenunciables del consumidor según la Ley N° 19.496. Escríbenos a {mail}.</p>
                    </Section>
                </div>

                <div className="text-center">
                    <Link href="/" className="text-sm font-bold text-zinc-500 hover:text-zinc-900">Volver al inicio</Link>
                </div>
            </div>
        </div>
    );
}
