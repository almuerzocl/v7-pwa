/**
 * `fetch` para clientes de Supabase que corren en el servidor de Next 14.
 *
 * Next cachea sin vencimiento los `fetch` GET y POST que no declaran `cache`, salvo que la ruta
 * exporte `POST`/`PATCH`… o haya leído `cookies()`/`headers()` antes. `export const dynamic =
 * 'force-dynamic'` NO lo evita. Con supabase-js eso sirve datos viejos tras un cambio en la base
 * (incidente Cri-Olla, 2026-10-04: `/api/takeaway-slots` seguía "cerrado" tras editar el horario).
 */
export const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-store' });
