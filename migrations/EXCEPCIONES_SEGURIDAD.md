# Excepciones de seguridad aceptadas (Supabase `kqanordhsmbtcwtjtrme`)

Última revisión: 2026-10-04. Cada excepción es una decisión consciente; si cambia el motivo, se revisa.

| # | Excepción | Motivo | Cuándo revisarla |
|---|---|---|---|
| 1 | `get_restaurant_dashboard_metrics` y `get_restaurant_analytics_report` siguen en `public` con EXECUTE para `authenticated` | El Restaurant Dashboard las llama por RPC con la sesión del usuario (`dashboard-actions.ts`). La guardia `can_access_restaurant()` ya limita a staff del restaurante o SUPER_ADMIN (probado con roles simulados). Moverlas exige cambiar el código a service_role + validar permisos a mano: más superficie de error para el mismo resultado. | Si alguna vez se llaman desde un cron/pg_cron (ver nota 1) o se abre un rol nuevo con acceso a otros restaurantes. |
| 2 | `check_restaurant_availability` y `get_restaurants_with_discounts_today` ejecutables por `anon` | Públicas a propósito (decisión 2026-09-30): la PWA muestra disponibilidad y descuentos antes de iniciar sesión. Solo devuelven datos ya públicos del restaurante. | Si dejan de ser públicas las fichas de restaurante. |
| 3 | Leaked Password Protection desactivada | Requiere plan Pro o superior (docs de Supabase). Pendiente de que el usuario confirme su plan y la active desde el dashboard. | Al subir de plan: activarla (Authentication → Sign In / Providers → Email). |
| 4 | `public.profiles` sigue con policy de INSERT propio (`profiles_insert_own`, solo rol USER) | El perfil se crea desde el cliente en el primer login (migración 017). | Si el alta de perfil pasa a un trigger en `auth.users`. |

## Notas

1. **Guardia `can_access_restaurant()` con service_role:** deja pasar (`auth.role() = 'service_role'`). Funciona con la `sb_secret_...` por PostgREST porque el gateway la traduce a un JWT con rol `service_role`. **No** deja pasar a una conexión directa a Postgres (pg_cron, SQL Editor como `postgres`): ahí `auth.role()` es NULL y la guardia lanza 42501 (probado). Un cron futuro debe llamar a `_get_restaurant_*_impl` (privadas, solo owner) o por PostgREST con service_role.
2. `restaurant_payments`, `error_logs` e `inventory_movements`: sin acceso para `anon`/`authenticated` (sin grant ni policy); policies explícitas solo para `service_role` en la migración 028.
3. `is_super_admin()` vive en el esquema `private` (no expuesto por la Data API) desde la migración 028.
