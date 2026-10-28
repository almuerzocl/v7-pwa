# PWA v7 (pruebas de UX y accesibilidad)

Copia de `almuerzocl/v5-pwa` (`origin/main` 0217bde, 2026-10-28) con historia nueva. Se despliega como servicio
`almuerzo-pwa-v7` en `app10.almuerzo.cl`, contra el MISMO Supabase de producción que `app2`. No tiene jobs de
Cloud Scheduler propios (los de `app2` siguen siendo los únicos). Origen de las mejoras: informe de evaluación UX
del 2026-10-28. Solo capa visual y de textos; ninguna regla de negocio cambia.

---

# pwa/ — Contenido de este directorio

Ver primero: [../../../CLAUDE.md](../../../CLAUDE.md) (reglas generales del entorno).

## Qué es

PWA de clientes de Almuerzo.cl (reservas, pedidos takeaway, perfil, descuentos). Next.js
App Router. Repo GitHub: `almuerzocl/v5-pwa`. Servicio Cloud Run: `almuerzo-pwa`
(prod → app2.almuerzo.cl, backup → app.almuerzo.cl).

## Correr en local

```bash
npm install
cp .env.example .env.local   # completar con las claves reales (no commitear)
npm run dev
```

## Desplegar

```bash
cp .env.deploy.example .env.deploy.local   # una sola vez, completar valores reales
./deploy_pwa.sh
```

El script corre `gcloud builds submit` con `cloudbuild.yaml` — es la única forma
válida de desplegar (ver sección 4 de `CLAUDE.md`). Los secretos de runtime
(`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `CRON_SECRET`) los inyecta Cloud Run
desde Secret Manager, no este script.

## Migraciones

`migrations/*.sql`, numeradas y corridas a mano contra el único proyecto Supabase
(`kqanordhsmbtcwtjtrme`) — no hay entorno de desarrollo separado todavía (ver sección 6
de `CLAUDE.md`).

## Notas recientes

- 2026-09-13: rama `feature/reservas-disponibilidad-perfil` mergeada contra `main` y
  pusheada — suma rutas de auth (magic-link, reset-password), disponibilidad, perfil
  (favoritos, descuentos, suscripciones), reservas y pedidos takeaway. **Sin revisar
  todavía la lógica de negocio/RLS antes de ir a producción.**
- 2026-09-13: `deploy_pwa.sh` corregido (secretos hardcodeados removidos, ver `CLAUDE.md`
  sección 5). **Las claves viejas (Supabase service role, Resend, Anthropic) siguen
  expuestas en el historial de git y deben rotarse.**

## Token de visor para tickets (relacionado con el ticket)

`POST /api/ticket-viewer-token` (`src/app/api/ticket-viewer-token/route.ts`): con la sesión del usuario valida
`auth.getUser()`, lee el registro por código con service_role y decide en código (`isRelatedToTicket`,
`src/lib/ticket-viewer-token.ts`) si es organizador/titular, invitado registrado (`guest_data[*].user_id`) o cliente
del pedido. Si lo es, firma un token de 60 s, un solo uso, ligado a usuario+código+tipo; si no, `{token: null}`.
`TicketFrame` lo pide antes de montar el iframe de `/reservations` y lo entrega en el fragmento (`#vt=`).
Contrato completo en `public-tickets/CONTENIDO.md`. Secreto `TICKET_VIEWER_SECRET` (Secret Manager
`ticket-viewer-signing-secret`).

- La relación NO se decide por RLS bajo la sesión: se decide en código con `isRelatedToTicket`, regla única que también
  usan `src/app/actions/my-tickets-actions.ts` ("Mis reservas", `/reservations/[id]`, `/orders/[id]`, lectura con
  service_role tras `auth.getUser()`). Invitados: `guest_data[*].user_id`, con `guests` (columna heredada) de respaldo
  cuando `guest_data` no trae datos. "Mis reservas" suma coincidencia por email/teléfono del perfil; el backfill de
  `user_id` en el invitado se hace en el servidor solo por email verificado.
- Migración 030 (`migrations/030_rls_reservations_orders_no_code_read.sql`, redactada): borra "Authenticated access by
  unique_code" en `reservations` y `takeaway_orders`, arregla la policy SELECT de invitados (misma regla, con
  `jsonb_path_exists`) y pasa INSERT/UPDATE a `authenticated` con `WITH CHECK`. Desplegar el código antes de aplicarla.
- **Dependencia:** si cambian las columnas `organizer_id`, `user_id`, `guest_data[*].user_id` (o se unifica `guests`),
  `isRelatedToTicket`, sus tests (`tests/ticket-viewer-token.test.ts`) y la policy de la 030 deben seguir diciendo lo mismo.
- Un ticket abierto fuera de la PWA (WhatsApp, otro navegador) sigue siendo anónimo: enmascarado y con límites.
- El modal de `/orders` no usa public-tickets (carga la página interna `/orders/[id]` de la PWA), por eso no lleva token.

## Correos de reserva (solo al confirmarse)

Regla: el correo de confirmación y las invitaciones a invitados se envían UNA vez y solo con la reserva
`CONFIRMADA` (autoaprobada, aprobada en el dashboard o creada por el restaurante). Una PENDIENTE, rechazada o
cancelada antes de confirmarse no envía correo de confirmación. Excepción (2026-10-06): una reserva RECHAZADA
avisa solo al organizador (migración 032; nunca a los invitados); la PENDIENTE no avisa nada. El wizard ya no envía correos: solo avisa al restaurante.

- Emisor único: `src/lib/server/reservation-confirmation.ts` (`processReservationConfirmations`).
- Disparo: Cloud Scheduler `pwa-reservation-confirmations` (cada minuto) -> `GET /api/cron/reservation-confirmations`
  (`CRON_SECRET`), y en línea desde `createReservationAction` si la reserva nace autoaprobada.
- Idempotencia (migración 031): `confirmation_notified_at`, `confirmation_notify_attempts` (tope 5),
  `confirmation_notify_claimed_at` (reclamo de 5 min) y `confirmation_sent` (a quién ya se envió) en `reservations`;
  reclamo atómico con `claim_reservation_confirmations()` (solo service_role). No se envía si la hora ya pasó.
- Errores de envío: `error_logs` (`source = 'reservation-confirmation'`).
- `src/lib/server/email.ts` envía por Resend y NO es invocable desde el navegador; `sendEmailAction` (server action,
  solo pedidos) exige sesión y solo envía al correo de la propia cuenta.
- Aviso de rechazo (migración 032): `processReservationRejections` en el mismo emisor y la misma ruta de cron; reclama con
  `claim_reservation_rejections()`, una sola vez, solo si la hora de la reserva no pasó, sin motivo
  (`reservations` no tiene columna de motivo de rechazo). Columnas `rejection_notified_at`, `rejection_notify_attempts`,
  `rejection_notify_claimed_at`.

## Eventos de cliente (medición del embudo del restaurante)

La PWA registra el comportamiento de los clientes con sesión para el reporte del restaurante (`restaurant-dashboard` →
`/dashboard/reports`). Las tablas y funciones SQL viven en `restaurant-dashboard/migrations/004_client_events.sql` a `006`.

- Navegador: `src/lib/client-events.ts` (cola en lotes cada 4 s, `sendBeacon` al ocultar la pestaña, se pausa 60 s ante un 401) y
  `src/hooks/useImpression.ts` / `ImpressionSentinel` (una impresión cuando la tarjeta estuvo visible ≥ 50 % por 600 ms; una por sesión,
  local y superficie). Todo es secundario: un fallo nunca debe afectar la pantalla.
- Eventos: `impression` (inicio, menús del día, favoritos), `profile_view` (modal de acciones y ficha del local), `menu_view` (carta),
  `share` y `call` (botones de la ficha), `order_start` (carrito) y `reservation_start` (asistente de reservas).
- Servidor: `POST /api/client-events` (solo con sesión; el `user_id` y la hora los pone el servidor; hasta 50 eventos por llamada y 60 llamadas
  por minuto) → `record_client_events()` (descarta al personal del propio local y aplica un tope de 300 eventos por usuario cada 10 min).
- Resumen y retención: `GET /api/cron/analytics-rollup` (`CRON_SECRET`), job de Cloud Scheduler `pwa-analytics-rollup` (04:30 Santiago) que
  llama a `rollup_client_events()`: resume por día y borra el detalle de más de 30 días.
- Privacidad: el local solo ve totales y personas distintas, nunca quién fue. Está dicho en `/privacidad`.
- Seguidores y suscritos: no hay evento propio; un disparador en `profiles` (migración 005) guarda el historial (alta/baja con fecha) escriba
  la lista quien la escriba (`toggleFavoriteAction` o directo desde el navegador).
- Tras un despliegue, la PWA instalada puede seguir con el JS viejo (caché de Serwist) y no emitir eventos hasta que se actualice.

## Eventos de plataforma (pasos del cliente)

Segunda fuente de eventos, distinta de `client-events` (que mide lo que cada LOCAL puede ver de sus clientes). Esta es solo para el
equipo de Almuerzo.cl y alimenta la «Analítica de flujos» del admin. Catálogo completo, privacidad y métricas: `ANALITICA.md` en `admin-dashboard`.

- Navegador: `src/lib/platform-events.ts` (`trackPlatformEvent`, `trackFailure`), mismo diseño que `client-events.ts`: cola, lotes cada 4 s, `sendBeacon`
  al cerrar, pausa con 401 y nunca lanza. `once: true` registra una sola vez por sesión de la app.
- Catálogo y validación compartidos navegador/servidor: `src/lib/platform-events-catalog.ts` (26 tipos; sin texto libre: props con lista blanca).
  Debe coincidir con el CHECK de `platform_events` y con `record_platform_events()` (migración `platform_events`, aplicada el 2026-10-10).
- Servidor: `POST /api/platform-events` (solo con sesión; el `user_id` y la hora los pone el servidor; vuelve a validar cada evento; 120 llamadas/min por usuario).
- Retención: detalle 30 días, luego `platform_daily_summary`; lo corre el job `pwa-analytics-rollup` (`/api/cron/analytics-rollup`, ahora con las dos fuentes).
- Qué se emite hoy: `session_start`, `pwa_install_prompt`, `pwa_installed` (`PlatformEventsBootstrap`), `login` (contraseña y enlace), `onboarding_step`/`onboarding_complete`,
  `location_set`, `favorite_toggle`, `daily_menu_subscribe`, `discount_view`/`discount_apply`/`discount_remove` (`DiscountPicker`), `cart_view`,
  `checkout_start`/`checkout_step`/`checkout_submit`/`checkout_error` (carrito y asistente de reserva), `ticket_view`, `cancel_start`, `client_error` (`error.tsx`).
- `checkout_submit` siempre significa «se creó la solicitud» (`result: ok`); lo que pasó después va en `step`: reserva `confirmed` (autoaprobada) o `pending` (a la espera del local); pedido `ok` o `discount_dropped` (el servidor quitó el descuento).
- Reservados (en el catálogo, sin emisor todavía): `signup_complete` (las altas salen de `profiles.created_at`), `push_permission` (no hay notificaciones push),
  `search` y `filter_apply` (la búsqueda aún no filtra), `ticket_share`, `offline_queue` (esta rama no tiene cola sin conexión).
- Al agregar un evento: tipo en el catálogo + en el CHECK y la lista de `record_platform_events()` (migración nueva) + prueba en `tests/platform-events-catalog.test.ts`.

## OlivIA (asistente de almuerzo de la portada) — EN RAMA `feature/olivia-chat`, sin desplegar

Ícono arriba a la derecha de la portada (junto al título «Restaurantes Cerca de Ti») que abre un panel de conversación. Solo recomienda locales y enlaza a su ficha: pedir y reservar los hace la persona. **Apagada por defecto**: la portada solo la monta si `olivia_config.enabled = true` (si la migración 043 no está aplicada, queda apagada sin error).

- Servidor: `src/app/api/olivia/route.ts` (sesión con `auth.getUser()`, usuario nunca del cuerpo) -> `src/lib/olivia/chat.ts` (flujo; todo lo externo entra por `deps`). Reglas y prompt en `src/lib/olivia/rules.ts`; los textos del catálogo se sanean y viajan dentro de `<datos>` como datos, nunca como instrucciones.
- Modelo: Claude Haiku (`olivia_config.model`), clave en Secret Manager `anthropic-api-key` -> `ANTHROPIC_API_KEY` (`cloudbuild.yaml`); nunca en el navegador ni en logs (no se registra el texto de la persona).
- Tope: 3 consultas por usuario y día de Santiago (Elite igual) y USD 5 al mes de gasto, aplicados por la base (migración `043_olivia_asistente.sql`, `olivia_reserve`/`olivia_finish`). Una consulta fallida antes de responder no se descuenta. Solo cuentas registradas.
- Copias diarias (`olivia_snapshots`): oferta de comida (solo platos disponibles de locales activos y con cupo de plan), ficha física de los locales y pronóstico (Open-Meteo, solo coordenadas de Santiago). Las reconstruye el cron `GET /api/cron/olivia-snapshots` (Scheduler `pwa-olivia-snapshots`, 10:30 Santiago, definido en `setup_schedulers.sh`, NO creado) y se reutilizan toda la ventana 11:00-14:00. Un plato que se agota o una ficha que cambia la marca `stale` (triggers de la 043) y se reconstruye en la próxima consulta; el pronóstico caduca a las 3 h.
- Historial propio (`src/lib/olivia/history.ts`): últimos 90 días, solo locales y platos con cuántas veces; sin montos ni contacto.
- Pruebas: `tests/olivia-*.test.ts` y `migrations/tests/043_olivia_asistente.test.mjs` (PGlite).
- **Orden de salida:** aplicar la 043 -> desplegar la PWA -> crear el job de Scheduler -> `UPDATE public.olivia_config SET enabled = true;` (apagar: `= false`). Precios en `olivia_config`: Haiku 5.5 a USD 0,10 / 0,50 por millón de tokens (verificados en la guía oficial de modelos).

## Categorías y opciones del menú (cliente) — 2026-10-27

- **Carta por categorías** (`/restaurant/[id]/menu`): `lib/menu-sections.ts` arma las secciones: «Menú del día» fija arriba (sus platos salen de su categoría), luego
  las categorías en el orden del restaurante (`menu_categories.position`); una categoría oculta o sin platos disponibles no se muestra. Chips fijos con scroll-spy
  (`MenuClient.tsx`). La página es dinámica sin caché y el service worker usa red primero para navegaciones y RSC: **un cambio de orden se ve en la siguiente carga de
  la carta, sin redeploy** (una carta ya abierta no se actualiza sola).
- **Opciones y extras:** un plato con grupos abre `components/menu/OptionSheet.tsx` (hoja modal accesible: radios/casillas, obligatorio, máximo, opciones apagadas
  visibles y deshabilitadas, precio vivo). Reglas puras en `lib/menu-options.ts` (**archivo idéntico en restaurant-dashboard; verificar con `cmp`**) con prueba de
  paridad contra SQL (`migrations/tests/047_menu_options.test.mjs`). Las opciones las lee `lib/inventory.ts → getOptionGroupsByItem`; si no se pueden leer, la carta
  falla (nunca se ofrece un plato con grupos como si no los tuviera).
- **Carrito por línea** (`CartContext`, `lib/cart-lines.ts`): un mismo plato con opciones distintas son líneas distintas (`lineKey`); `price` es el precio unitario final.
- **Precio:** lo recalcula la base (trigger `takeaway_price_guard`, migración 047). Si el total no coincide la creación falla con `price_error` (`lib/takeaway/order-price-error.ts`)
  y el carrito se actualiza con los precios corregidos para confirmar de nuevo; si una opción ya no sirve se pide quitar ese plato. **El trigger nace apagado**
  (`price_enforcement.enabled = false`): encender con `UPDATE public.price_enforcement SET enabled = true;` solo con selector, pedido manual y dashboard desplegados.
- **Correo «Pedido confirmado»:** si algún plato lleva opciones agrega el bloque «Tu pedido» con cada plato y lo elegido (`order-lines.ts`, **idéntico en el dashboard**); sin opciones el
  correo no cambia. `TicketDigital.view.tsx` (idéntico en los 3 repos) muestra las opciones bajo cada plato.
- **Pendiente anotado:** stock por opción (hoy el stock es del plato).
