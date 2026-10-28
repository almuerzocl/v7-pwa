#!/bin/bash
# Declara los Cloud Scheduler jobs para almuerzo-pwa en GCP.
# Ejecutar una sola vez (o al cambiar el servicio/región).
# Requiere: gcloud autenticado con permisos cloudscheduler.jobs.create

set -euo pipefail

export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.13

REGION="us-central1"
SERVICE="almuerzo-pwa"
PROJECT=$(gcloud config get-value project 2>/dev/null)

echo "Proyecto: $PROJECT | Servicio: $SERVICE | Región: $REGION"

# URL del servicio Cloud Run
SERVICE_URL=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --format="value(status.url)" 2>/dev/null)

if [[ -z "$SERVICE_URL" ]]; then
  echo "ERROR: No se pudo obtener la URL del servicio '$SERVICE'. Verifica que esté desplegado."
  exit 1
fi

echo "URL del servicio: $SERVICE_URL"

# Recuperar el secret desde Secret Manager
CRON_SECRET=$(gcloud secrets versions access latest --secret="cron-secret" 2>/dev/null)

if [[ -z "$CRON_SECRET" ]]; then
  echo "ERROR: No se pudo leer el secret 'cron-secret' desde Secret Manager."
  exit 1
fi

# (2026-10-05: se suma pwa-reservation-confirmations, cada minuto. 2026-10-07: se suma pwa-analytics-rollup, diario 04:30.)
# Estado real en GCP verificado el 2026-10-02 (us-central1): pwa-close-day, pwa-calculate-reputation y
# pwa-close-pending. Este script se alinea con ESOS nombres y horarios. ORDEN IMPORTANTE: la reputación se
# calcula DESPUÉS del cierre del día, porque close-day es quien marca NO_SHOW / NO_RETIRADO.

# ── Job 1: pwa-close-day ──────────────────────────────────────────
# 03:00 hora Santiago → cierra reservas y pedidos del día anterior (criterio de reputación en la ruta)
gcloud scheduler jobs create http pwa-close-day \
  --location="$REGION" \
  --schedule="0 3 * * *" \
  --time-zone="America/Santiago" \
  --uri="$SERVICE_URL/api/cron/close-day" \
  --http-method=GET \
  --headers="Authorization=Bearer $CRON_SECRET" \
  --attempt-deadline="540s" \
  --description="Close day reservations/orders (03:00 Santiago)" \
  2>/dev/null \
  && echo "✓ Job 'pwa-close-day' creado" \
  || gcloud scheduler jobs update http pwa-close-day \
       --location="$REGION" \
       --schedule="0 3 * * *" \
       --time-zone="America/Santiago" \
       --uri="$SERVICE_URL/api/cron/close-day" \
       --http-method=GET \
       --headers="Authorization=Bearer $CRON_SECRET" \
       --attempt-deadline="540s" \
       --description="Close day reservations/orders (03:00 Santiago)" \
  && echo "✓ Job 'pwa-close-day' actualizado"

# ── Job 2: pwa-calculate-reputation ───────────────────────────────
# 03:30 hora Santiago (después de close-day) → la ruta solo ejecuta calculate_daily_reputation() en Supabase
# (migración 020): única fuente de verdad de la fórmula de reputación.
gcloud scheduler jobs create http pwa-calculate-reputation \
  --location="$REGION" \
  --schedule="30 3 * * *" \
  --time-zone="America/Santiago" \
  --uri="$SERVICE_URL/api/tasks/calculate-reputation" \
  --http-method=GET \
  --headers="Authorization=Bearer $CRON_SECRET" \
  --attempt-deadline="540s" \
  --description="Recalculate user reputation (03:30 Santiago)" \
  2>/dev/null \
  && echo "✓ Job 'pwa-calculate-reputation' creado" \
  || gcloud scheduler jobs update http pwa-calculate-reputation \
       --location="$REGION" \
       --schedule="30 3 * * *" \
       --time-zone="America/Santiago" \
       --uri="$SERVICE_URL/api/tasks/calculate-reputation" \
       --http-method=GET \
       --headers="Authorization=Bearer $CRON_SECRET" \
       --attempt-deadline="540s" \
       --description="Recalculate user reputation (03:30 Santiago)" \
  && echo "✓ Job 'pwa-calculate-reputation' actualizado"

# ── Job 3: pwa-reservation-confirmations ──────────────────────────
# Cada minuto → envía los correos de las reservas que pasaron a CONFIRMADA y aún no se avisaron (migración 031,
# src/lib/server/reservation-confirmations). Idempotente: la ruta reclama las filas de forma atómica.
gcloud scheduler jobs create http pwa-reservation-confirmations \
  --location="$REGION" \
  --schedule="* * * * *" \
  --time-zone="America/Santiago" \
  --uri="$SERVICE_URL/api/cron/reservation-confirmations" \
  --http-method=GET \
  --headers="Authorization=Bearer $CRON_SECRET" \
  --attempt-deadline="120s" \
  --description="Correos de reservas confirmadas (cada minuto)" \
  2>/dev/null \
  && echo "✓ Job 'pwa-reservation-confirmations' creado" \
  || gcloud scheduler jobs update http pwa-reservation-confirmations \
       --location="$REGION" \
       --schedule="* * * * *" \
       --time-zone="America/Santiago" \
       --uri="$SERVICE_URL/api/cron/reservation-confirmations" \
       --http-method=GET \
       --headers="Authorization=Bearer $CRON_SECRET" \
       --attempt-deadline="120s" \
       --description="Correos de reservas confirmadas (cada minuto)" \
  && echo "✓ Job 'pwa-reservation-confirmations' actualizado"

# ── Job 4: pwa-analytics-rollup ───────────────────────────────────
# 04:30 hora Santiago → resume por día los eventos de cliente (restaurant_daily_summary) y borra el detalle de más de
# 90 días (migración 004 del restaurant-dashboard; src/app/api/cron/analytics-rollup). Idempotente.
gcloud scheduler jobs create http pwa-analytics-rollup \
  --location="$REGION" \
  --schedule="30 4 * * *" \
  --time-zone="America/Santiago" \
  --uri="$SERVICE_URL/api/cron/analytics-rollup" \
  --http-method=GET \
  --headers="Authorization=Bearer $CRON_SECRET" \
  --attempt-deadline="300s" \
  --description="Resumen diario de eventos de cliente y retención de 90 dias (04:30 Santiago)" \
  2>/dev/null \
  && echo "✓ Job 'pwa-analytics-rollup' creado" \
  || gcloud scheduler jobs update http pwa-analytics-rollup \
       --location="$REGION" \
       --schedule="30 4 * * *" \
       --time-zone="America/Santiago" \
       --uri="$SERVICE_URL/api/cron/analytics-rollup" \
       --http-method=GET \
       --headers="Authorization=Bearer $CRON_SECRET" \
       --attempt-deadline="300s" \
       --description="Resumen diario de eventos de cliente y retención de 90 dias (04:30 Santiago)" \
  && echo "✓ Job 'pwa-analytics-rollup' actualizado"

# ── Job 5: pwa-olivia-snapshots ───────────────────────────────────
# 10:30 hora Santiago (antes de la ventana de almuerzo 11:00-14:00) → reconstruye las copias del día de OlivIA (oferta, ficha de
# locales y pronóstico de Open-Meteo) y limpia lo viejo (migración 043; src/app/api/cron/olivia-snapshots). Idempotente.
# NO se crea solo al desplegar: correr este script es una decisión explícita (ver CLAUDE.md, sección 4).
gcloud scheduler jobs create http pwa-olivia-snapshots \
  --location="$REGION" \
  --schedule="30 10 * * *" \
  --time-zone="America/Santiago" \
  --uri="$SERVICE_URL/api/cron/olivia-snapshots" \
  --http-method=GET \
  --headers="Authorization=Bearer $CRON_SECRET" \
  --attempt-deadline="120s" \
  --description="Copias diarias de OlivIA: oferta, locales y clima (10:30 Santiago)" \
  2>/dev/null \
  && echo "✓ Job 'pwa-olivia-snapshots' creado" \
  || gcloud scheduler jobs update http pwa-olivia-snapshots \
       --location="$REGION" \
       --schedule="30 10 * * *" \
       --time-zone="America/Santiago" \
       --uri="$SERVICE_URL/api/cron/olivia-snapshots" \
       --http-method=GET \
       --headers="Authorization=Bearer $CRON_SECRET" \
       --attempt-deadline="120s" \
       --description="Copias diarias de OlivIA: oferta, locales y clima (10:30 Santiago)" \
  && echo "✓ Job 'pwa-olivia-snapshots' actualizado"

# pwa-close-pending (03:10) está OBSOLETO: apuntaba a /api/tasks/close-pending, ruta que ya no existe (404 diario)
# y cuyo trabajo hoy hace close-day. Borrarlo con:
#   gcloud scheduler jobs delete pwa-close-pending --location="$REGION"

# Los descuentos ya no se refrescan desde la PWA: el servicio almuerzo-discounts tiene su propio job
# (discounts-refresh-cache, 03:45 Santiago; ver v6/produccion/discounts/scripts/gcp-setup.sh).

echo ""
echo "Jobs registrados:"
gcloud scheduler jobs list --location="$REGION" --filter="name:close-day-job OR name:calculate-reputation-job"
