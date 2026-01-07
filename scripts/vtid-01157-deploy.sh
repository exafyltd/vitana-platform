#!/usr/bin/env bash
# VTID-01157: Gateway Supabase JWT Auth Deployment Script
# This script completes the deployment of VTID-01157 (Dev Onboarding MVP)
#
# Prerequisites:
# - gcloud CLI configured with access to lovable-vitana-vers1 project
# - Git push access to exafyltd/vitana-platform
# - SUPABASE_JWT_SECRET value (from Supabase dashboard > Settings > API > JWT Secret)
#
# Run this script from the vitana-platform root directory

set -euo pipefail

PROJECT="lovable-vitana-vers1"
REGION="us-central1"
GATEWAY_URL="https://gateway-q74ibpv6ia-uc.a.run.app"

echo "=============================================="
echo "VTID-01157: Gateway Supabase JWT Auth Deploy"
echo "=============================================="

# ==========================================
# STEP 0: Pre-flight Checks
# ==========================================
echo ""
echo "Step 0: Pre-flight checks..."

if ! command -v gcloud &> /dev/null; then
    echo "ERROR: gcloud CLI not found. Please install Google Cloud SDK."
    exit 1
fi

if ! command -v curl &> /dev/null; then
    echo "ERROR: curl not found."
    exit 1
fi

echo "✓ Prerequisites check passed"

# ==========================================
# STEP 1: SECRET MANAGER
# ==========================================
echo ""
echo "Step 1: Checking SUPABASE_JWT_SECRET in Secret Manager..."

if gcloud secrets describe SUPABASE_JWT_SECRET --project="$PROJECT" &>/dev/null; then
    echo "✓ SUPABASE_JWT_SECRET already exists"
    echo "  To rotate, run:"
    echo "  echo -n \"\$SUPABASE_JWT_SECRET_VALUE\" | gcloud secrets versions add SUPABASE_JWT_SECRET --project=$PROJECT --data-file=-"
else
    echo "✗ SUPABASE_JWT_SECRET does not exist"
    echo ""
    echo "  Create it with:"
    echo "  echo -n \"\$SUPABASE_JWT_SECRET_VALUE\" | gcloud secrets create SUPABASE_JWT_SECRET --project=$PROJECT --data-file=-"
    echo ""
    echo "  Get the JWT Secret from: Supabase Dashboard > Settings > API > JWT Secret"
    read -p "Press Enter after creating the secret, or Ctrl+C to abort..."
fi

# ==========================================
# STEP 1b: Grant IAM Access
# ==========================================
echo ""
echo "Step 1b: Checking Gateway service account access..."

SA=$(gcloud run services describe gateway \
    --project="$PROJECT" --region="$REGION" \
    --format="value(spec.template.spec.serviceAccountName)" 2>/dev/null || echo "")

if [ -z "$SA" ]; then
    echo "WARNING: Could not determine Gateway service account"
    echo "Using default compute service account"
    SA="${PROJECT}@appspot.gserviceaccount.com"
fi

echo "Gateway Service Account: $SA"

# Check if binding exists
BINDING_EXISTS=$(gcloud secrets get-iam-policy SUPABASE_JWT_SECRET \
    --project="$PROJECT" --format=json 2>/dev/null | \
    grep -c "serviceAccount:$SA" || echo "0")

if [ "$BINDING_EXISTS" = "0" ]; then
    echo "Granting secretAccessor role to $SA..."
    gcloud secrets add-iam-policy-binding SUPABASE_JWT_SECRET \
        --project="$PROJECT" \
        --member="serviceAccount:$SA" \
        --role="roles/secretmanager.secretAccessor" \
        --quiet
    echo "✓ IAM binding added"
else
    echo "✓ IAM binding already exists"
fi

# ==========================================
# STEP 2: WIRE SECRET INTO GATEWAY ENV
# ==========================================
echo ""
echo "Step 2: Wiring SUPABASE_JWT_SECRET into Gateway environment..."

gcloud run services update gateway \
    --project="$PROJECT" --region="$REGION" \
    --update-secrets=SUPABASE_JWT_SECRET=SUPABASE_JWT_SECRET:latest \
    --quiet

# Verify
echo "Verifying secret binding..."
gcloud run services describe gateway \
    --project="$PROJECT" --region="$REGION" \
    --format="yaml(spec.template.spec.containers[0].env)" | grep -A1 SUPABASE_JWT_SECRET && \
    echo "✓ SUPABASE_JWT_SECRET is bound" || echo "WARNING: Secret binding not found in output"

# ==========================================
# STEP 3: MERGE AND DEPLOY
# ==========================================
echo ""
echo "Step 3: Creating PR and deploying via Gateway CI/CD API..."

# Get current revision before deploy
REVISION_BEFORE=$(gcloud run services describe gateway \
    --project="$PROJECT" --region="$REGION" \
    --format="value(status.latestReadyRevisionName)" 2>/dev/null || echo "unknown")

echo "Current revision: $REVISION_BEFORE"

# Create/merge PR via Gateway autonomous endpoint
echo "Triggering autonomous PR merge..."
PR_RESULT=$(curl -sS -X POST "$GATEWAY_URL/api/v1/github/autonomous-pr-merge" \
    -H "Content-Type: application/json" \
    -H "X-VTID: VTID-01157" \
    -d '{
        "vtid": "VTID-01157",
        "repo": "exafyltd/vitana-platform",
        "head_branch": "claude/prepare-lovable-auth-Xa0Ag",
        "base_branch": "main",
        "title": "Gateway Supabase JWT Auth Middleware + /api/v1/auth/me",
        "body": "## Summary\n- Add Supabase JWT verification middleware using jose library\n- Add /api/v1/auth/me endpoint for authenticated user identity\n- Add /api/v1/auth/health endpoint for auth service health check\n- Update deploy scripts to bind SUPABASE_JWT_SECRET from Secret Manager\n\n## VTID: VTID-01157\n\n## Test Plan\n- Verify /api/v1/auth/health returns 200\n- Verify /api/v1/auth/me returns 401 without token\n- Verify /api/v1/auth/me returns 200 with valid Supabase JWT",
        "merge_method": "squash",
        "automerge": true,
        "max_ci_wait_seconds": 300,
        "deploy": {
            "services": ["gateway"],
            "environment": "dev"
        }
    }')

echo "PR Result:"
echo "$PR_RESULT" | jq . 2>/dev/null || echo "$PR_RESULT"

MERGED=$(echo "$PR_RESULT" | jq -r '.merged // false')
if [ "$MERGED" = "true" ]; then
    echo "✓ PR merged successfully"
    MERGE_SHA=$(echo "$PR_RESULT" | jq -r '.merge_sha // "unknown"')
    echo "  Merge SHA: $MERGE_SHA"
else
    echo "WARNING: PR merge status unclear. Check Gateway logs."
fi

# Wait for deploy to complete
echo ""
echo "Waiting for deployment to complete (60s)..."
sleep 60

# ==========================================
# STEP 4: VERIFY DEPLOYMENT
# ==========================================
echo ""
echo "Step 4: Verifying deployment..."

# Get new revision
REVISION_AFTER=$(gcloud run services describe gateway \
    --project="$PROJECT" --region="$REGION" \
    --format="value(status.latestReadyRevisionName)" 2>/dev/null || echo "unknown")

GATEWAY_LIVE_URL=$(gcloud run services describe gateway \
    --project="$PROJECT" --region="$REGION" \
    --format="value(status.url)" 2>/dev/null || echo "$GATEWAY_URL")

echo "Previous revision: $REVISION_BEFORE"
echo "Current revision:  $REVISION_AFTER"
echo "Gateway URL:       $GATEWAY_LIVE_URL"

if [ "$REVISION_BEFORE" = "$REVISION_AFTER" ]; then
    echo "WARNING: Revision did not change. Deploy may not have completed."
fi

echo ""
echo "Running endpoint verification..."

# Test 1: /api/v1/auth/health
echo ""
echo "Test 1: GET /api/v1/auth/health"
curl -i "$GATEWAY_LIVE_URL/api/v1/auth/health"
echo ""

# Test 2: /api/v1/auth/me without token (expect 401)
echo ""
echo "Test 2: GET /api/v1/auth/me (no token - expect 401)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_LIVE_URL/api/v1/auth/me")
if [ "$HTTP_CODE" = "401" ]; then
    echo "✓ Correctly returns 401 without token"
else
    echo "✗ Expected 401, got $HTTP_CODE"
fi

# Test 3: /api/v1/auth/me with bad token (expect 401)
echo ""
echo "Test 3: GET /api/v1/auth/me (bad token - expect 401)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_LIVE_URL/api/v1/auth/me" \
    -H "Authorization: Bearer bad-token")
if [ "$HTTP_CODE" = "401" ]; then
    echo "✓ Correctly returns 401 with invalid token"
else
    echo "✗ Expected 401, got $HTTP_CODE"
fi

# Test 4: With valid token (requires user to provide)
echo ""
echo "Test 4: GET /api/v1/auth/me (valid token - expect 200)"
echo "  To test with a valid token, run:"
echo "  curl -i \"$GATEWAY_LIVE_URL/api/v1/auth/me\" -H \"Authorization: Bearer \$TOKEN\""

# ==========================================
# STEP 5: TERMINALIZE VTID-01157
# ==========================================
echo ""
echo "Step 5: Terminalizing VTID-01157 in vtid_ledger..."

TERMINAL_RESULT=$(curl -sS -X POST "$GATEWAY_LIVE_URL/api/v1/oasis/vtid/terminalize" \
    -H "Content-Type: application/json" \
    -H "X-VTID: VTID-01157" \
    -d '{
        "vtid": "VTID-01157",
        "outcome": "success",
        "actor": "manual",
        "commit_sha": "'"$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"'"
    }')

echo "Terminalization result:"
echo "$TERMINAL_RESULT" | jq . 2>/dev/null || echo "$TERMINAL_RESULT"

IS_TERMINAL=$(echo "$TERMINAL_RESULT" | jq -r '.is_terminal // false')
if [ "$IS_TERMINAL" = "true" ]; then
    echo "✓ VTID-01157 marked as terminal (success)"
else
    echo "WARNING: Terminalization status unclear"
fi

# ==========================================
# SUMMARY
# ==========================================
echo ""
echo "=============================================="
echo "VTID-01157 Deployment Summary"
echo "=============================================="
echo "Revision:      $REVISION_AFTER"
echo "Gateway URL:   $GATEWAY_LIVE_URL"
echo "Auth Health:   $GATEWAY_LIVE_URL/api/v1/auth/health"
echo "Auth Me:       $GATEWAY_LIVE_URL/api/v1/auth/me"
echo ""
echo "New endpoints available:"
echo "  GET  /api/v1/auth/health  - Auth service health"
echo "  GET  /api/v1/auth/me      - Authenticated user identity"
echo "  GET  /api/v1/auth/me/debug - JWT claims debug (exafy_admin only)"
echo ""
echo "Middleware exports available:"
echo "  requireAuth       - Require valid JWT"
echo "  optionalAuth      - Parse JWT if present"
echo "  requireExafyAdmin - Require exafy_admin=true"
echo "  requireAdminAuth  - Require admin role"
echo ""
echo "=============================================="
