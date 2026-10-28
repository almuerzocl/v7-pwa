#!/bin/bash

# Configuration
PROJECT_ID=$(gcloud config get-value project)

# Extract values from .env
SUPABASE_URL=$(grep NEXT_PUBLIC_SUPABASE_URL .env | cut -d '=' -f2)
SUPABASE_ANON_KEY=$(grep NEXT_PUBLIC_SUPABASE_ANON_KEY .env | cut -d '=' -f2)
SUPABASE_SERVICE_ROLE_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY .env | cut -d '=' -f2)

create_secret() {
  local NAME=$1
  local VALUE=$2
  
  echo "Creating secret $NAME..."
  # Create secret if it doesn't exist
  gcloud secrets create "$NAME" --replication-policy="automatic" || echo "Secret $NAME already exists"
  
  # Add version
  echo -n "$VALUE" | gcloud secrets versions add "$NAME" --data-file=-
}

create_secret "ALMUERZO_SUPABASE_URL" "$SUPABASE_URL"
create_secret "ALMUERZO_SUPABASE_ANON_KEY" "$SUPABASE_ANON_KEY"
create_secret "ALMUERZO_SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_SERVICE_ROLE_KEY"

echo "Secrets created successfully."
