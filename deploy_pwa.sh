#!/bin/bash
set -euo pipefail
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3

# Runtime secrets (SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, CRON_SECRET) son inyectados
# por Cloud Run directo desde Secret Manager via --set-secrets en cloudbuild.yaml — nunca
# se leen de este script ni del entorno de shell en build time.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.deploy.local"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${NEXT_PUBLIC_SUPABASE_URL:?Falta NEXT_PUBLIC_SUPABASE_URL. Copia .env.deploy.example a .env.deploy.local y complétalo.}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?Falta NEXT_PUBLIC_SUPABASE_ANON_KEY.}"
: "${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:?Falta NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.}"
: "${NEXT_PUBLIC_TICKET_URL:=https://tickets2.almuerzo.cl}"
: "${NEXT_PUBLIC_PWA_URL:=https://app2.almuerzo.cl}"

gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions _NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL",_NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY",_NEXT_PUBLIC_GOOGLE_MAPS_API_KEY="$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",_NEXT_PUBLIC_TICKET_URL="$NEXT_PUBLIC_TICKET_URL",_NEXT_PUBLIC_PWA_URL="$NEXT_PUBLIC_PWA_URL" \
  .
