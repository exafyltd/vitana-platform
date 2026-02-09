#!/usr/bin/env bash
# VTID-01230: Complete deployment script for Stripe Connect Express
# Run this in Cloud Shell after: cd ~/vitana-platform && git pull

set -euo pipefail

PROJECT="lovable-vitana-vers1"
REGION="us-central1"

echo "=========================================="
echo "VTID-01230 Deployment Script"
echo "=========================================="

# Step 1: Get Supabase credentials
echo "Step 1: Getting Supabase credentials..."
SUPABASE_URL=$(gcloud secrets versions access latest --secret="SUPABASE_URL" --project=$PROJECT)
SUPABASE_SERVICE_ROLE=$(gcloud secrets versions access latest --secret="SUPABASE_SERVICE_ROLE" --project=$PROJECT)

echo "✓ Credentials retrieved"

# Step 2: Run database migration
echo ""
echo "Step 2: Running database migration..."
MIGRATION_SQL=$(cat supabase/migrations/20260209_vtid_01230_stripe_connect.sql)

# Execute migration via Supabase REST API (query endpoint for raw SQL)
# Note: Supabase doesn't have a direct SQL execution endpoint, so we'll use psql if available
# or fall back to manual instruction
if command -v psql &> /dev/null; then
  # Extract database connection details from SUPABASE_URL
  DB_HOST=$(echo "$SUPABASE_URL" | sed -E 's|https://([^.]+)\.supabase\.co.*|db.\1.supabase.co|')
  PGPASSWORD="$SUPABASE_SERVICE_ROLE" psql \
    -h "$DB_HOST" \
    -p 5432 \
    -U postgres \
    -d postgres \
    -f supabase/migrations/20260209_vtid_01230_stripe_connect.sql
  echo "✓ Migration executed successfully"
else
  echo "⚠️  psql not found - please run migration manually in Supabase Dashboard SQL Editor:"
  echo "   File: supabase/migrations/20260209_vtid_01230_stripe_connect.sql"
  read -p "Press Enter after running migration manually..."
fi

# Step 3: Create/update GCP secrets
echo ""
echo "Step 3: Creating/updating GCP secrets..."

# Check if STRIPE_CONNECT_WEBHOOK_SECRET exists
if gcloud secrets describe STRIPE_CONNECT_WEBHOOK_SECRET --project=$PROJECT &>/dev/null; then
  echo "✓ STRIPE_CONNECT_WEBHOOK_SECRET already exists"
else
  # Create with placeholder (user must update with real webhook secret from Stripe)
  echo -n "whsec_placeholder_update_in_stripe_dashboard" | \
    gcloud secrets create STRIPE_CONNECT_WEBHOOK_SECRET \
    --data-file=- \
    --project=$PROJECT
  echo "⚠️  STRIPE_CONNECT_WEBHOOK_SECRET created with placeholder - UPDATE IN STRIPE DASHBOARD"
fi

# Check if FRONTEND_URL exists
if gcloud secrets describe FRONTEND_URL --project=$PROJECT &>/dev/null; then
  echo "✓ FRONTEND_URL already exists"
else
  # Create with production frontend URL
  echo -n "https://vitana-lovable-vers1.lovable.app" | \
    gcloud secrets create FRONTEND_URL \
    --data-file=- \
    --project=$PROJECT
  echo "✓ FRONTEND_URL created"
fi

# Step 4: Deploy Gateway
echo ""
echo "Step 4: Deploying Gateway..."
./scripts/deploy/deploy-service.sh gateway

echo ""
echo "=========================================="
echo "✓ VTID-01230 Deployment Complete"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Configure Stripe Connect webhook in Stripe Dashboard:"
echo "   Webhook URL: https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/stripe/webhook/connect"
echo "   Events: account.updated, account.external_account.created, account.external_account.updated"
echo "2. Update STRIPE_CONNECT_WEBHOOK_SECRET in GCP Secret Manager with real webhook secret"
echo "3. Test creator onboarding flow"
echo ""
