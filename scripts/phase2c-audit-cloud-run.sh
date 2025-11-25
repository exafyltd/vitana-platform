#!/bin/bash

# Phase 2C - Cloud Run Label & Environment Variable Enforcement
# VTID: DEV-CICDL-0033
#
# This script audits all Cloud Run services and enforces VTID labels + env vars
#
# Usage: ./scripts/phase2c-audit-cloud-run.sh [--dry-run] [--fix]

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

DRY_RUN=false
FIX=false
GATEWAY_URL="${GATEWAY_URL:-https://vitana-gateway-86804897789.us-central1.run.app}"
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "lovable-vitana-vers1")
REGION="us-central1"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --fix)
      FIX=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--dry-run] [--fix]"
      exit 1
      ;;
  esac
done

echo -e "${BLUE}🔍 Phase 2C - Cloud Run Service Audit${NC}"
echo "=================================================="
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Mode: $([ "$FIX" = true ] && echo "FIX" || echo "AUDIT ONLY")"
echo ""

# Output files
REPORT_FILE="docs/reports/phase2c-cloud-run-labels-$(date +%Y%m%d-%H%M%S).md"
mkdir -p docs/reports

# Start report
cat > "$REPORT_FILE" << EOF
# Phase 2C - Cloud Run Services Audit Report

**VTID:** DEV-CICDL-0033  
**Date:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")  
**Project:** $PROJECT_ID  
**Region:** $REGION

## Services Audited

| Service | Old Labels | New Labels | Status | Action Required |
|---------|-----------|------------|--------|-----------------|
EOF

# Get all Cloud Run services
echo -e "${BLUE}📋 Fetching Cloud Run services...${NC}"
SERVICES=$(gcloud run services list --platform managed --region "$REGION" --format="value(metadata.name)" 2>/dev/null)

if [ -z "$SERVICES" ]; then
  echo -e "${RED}❌ No services found or gcloud not configured${NC}"
  exit 1
fi

TOTAL_SERVICES=0
SERVICES_FIXED=0
SERVICES_NEED_ATTENTION=0

# Function to infer VTID info from service name
infer_vtid_info() {
  local SERVICE_NAME="$1"
  local VTID="UNSET"
  local LAYER="UNSET"
  local MODULE="UNSET"
  
  # Inference rules based on service naming patterns
  case "$SERVICE_NAME" in
    *gateway*)
      LAYER="CICDL"
      MODULE="GATEWAY"
      VTID="DEV-CICDL-0031" # Known from Phase 2
      ;;
    *deploy-watcher*)
      LAYER="CICDL"
      MODULE="WATCHER"
      VTID="DEV-CICDL-0031"
      ;;
    *planner*)
      LAYER="AGTL"
      MODULE="PLANNER"
      VTID="UNSET" # Needs manual assignment
      ;;
    *worker*)
      LAYER="AGTL"
      MODULE="WORKER"
      VTID="UNSET"
      ;;
    *validator*)
      LAYER="AGTL"
      MODULE="VALIDATOR"
      VTID="UNSET"
      ;;
    *agent*)
      LAYER="AGTL"
      MODULE="AGENT"
      VTID="UNSET"
      ;;
    *mcp*)
      LAYER="MCPL"
      MODULE="MCP"
      VTID="UNSET"
      ;;
    *)
      # Unknown pattern
      LAYER="UNSET"
      MODULE="UNSET"
      VTID="UNSET"
      ;;
  esac
  
  echo "$VTID|$LAYER|$MODULE"
}

# Function to emit event to OASIS
emit_event() {
  local SERVICE="$1"
  local STATUS="$2"
  local VTID="$3"
  local LAYER="$4"
  local MODULE="$5"
  local MESSAGE="$6"
  
  curl -sS -X POST "$GATEWAY_URL/api/v1/oasis/events/ingest" \
    -H "Content-Type: application/json" \
    -d "{
      \"vtid\": \"$VTID\",
      \"source\": \"gcp.deploy\",
      \"kind\": \"meta.fixed\",
      \"status\": \"$STATUS\",
      \"title\": \"${LAYER}-${MODULE}-META-FIXED\",
      \"meta\": {
        \"service\": \"$SERVICE\",
        \"message\": \"$MESSAGE\",
        \"project\": \"$PROJECT_ID\",
        \"region\": \"$REGION\"
      }
    }" >/dev/null 2>&1 || true
}

# Process each service
for SERVICE in $SERVICES; do
  TOTAL_SERVICES=$((TOTAL_SERVICES + 1))
  echo -e "\n${BLUE}[${TOTAL_SERVICES}] Processing: $SERVICE${NC}"
  
  # Get current labels
  CURRENT_LABELS=$(gcloud run services describe "$SERVICE" --region "$REGION" --format="value(metadata.labels)" 2>/dev/null || echo "{}")
  
  # Extract current VTID labels if they exist
  CURRENT_VTID=$(echo "$CURRENT_LABELS" | grep -oP 'vtid=\K[^,}]+' || echo "")
  CURRENT_LAYER=$(echo "$CURRENT_LABELS" | grep -oP 'vt_layer=\K[^,}]+' || echo "")
  CURRENT_MODULE=$(echo "$CURRENT_LABELS" | grep -oP 'vt_module=\K[^,}]+' || echo "")
  
  # Check if service has proper labels
  if [ -n "$CURRENT_VTID" ] && [ -n "$CURRENT_LAYER" ] && [ -n "$CURRENT_MODULE" ]; then
    echo -e "  ${GREEN}✅ Already has VTID labels${NC}"
    echo -e "     vtid=$CURRENT_VTID, vt_layer=$CURRENT_LAYER, vt_module=$CURRENT_MODULE"
    
    # Add to report
    echo "| $SERVICE | Complete | Complete | ✅ Up to date | None |" >> "$REPORT_FILE"
    continue
  fi
  
  # Infer missing values
  echo -e "  ${YELLOW}⚠️  Missing or incomplete VTID labels${NC}"
  INFERRED=$(infer_vtid_info "$SERVICE")
  NEW_VTID=$(echo "$INFERRED" | cut -d'|' -f1)
  NEW_LAYER=$(echo "$INFERRED" | cut -d'|' -f2)
  NEW_MODULE=$(echo "$INFERRED" | cut -d'|' -f3)
  
  echo -e "  ${BLUE}📝 Inferred values:${NC}"
  echo -e "     vtid=$NEW_VTID, vt_layer=$NEW_LAYER, vt_module=$NEW_MODULE"
  
  # Determine status
  if [ "$NEW_VTID" = "UNSET" ]; then
    STATUS="needs_attention"
    ACTION="Manual VTID assignment required"
    SERVICES_NEED_ATTENTION=$((SERVICES_NEED_ATTENTION + 1))
    echo -e "  ${RED}❌ Cannot auto-fix: VTID=UNSET${NC}"
  else
    STATUS="success"
    ACTION="Ready to apply"
  fi
  
  # Add to report
  OLD_LABELS="${CURRENT_VTID:-(none)},${CURRENT_LAYER:-(none)},${CURRENT_MODULE:-(none)}"
  NEW_LABELS="$NEW_VTID,$NEW_LAYER,$NEW_MODULE"
  
  if [ "$STATUS" = "needs_attention" ]; then
    echo "| $SERVICE | $OLD_LABELS | $NEW_LABELS | ⚠️ Needs attention | $ACTION |" >> "$REPORT_FILE"
  else
    echo "| $SERVICE | $OLD_LABELS | $NEW_LABELS | ✅ Ready | $ACTION |" >> "$REPORT_FILE"
  fi
  
  # Fix if requested and possible
  if [ "$FIX" = true ] && [ "$STATUS" = "success" ]; then
    echo -e "  ${GREEN}🔧 Applying fix...${NC}"
    
    if [ "$DRY_RUN" = true ]; then
      echo "  [DRY RUN] Would execute:"
      echo "    gcloud run services update $SERVICE \\"
      echo "      --region $REGION \\"
      echo "      --update-labels vtid=$NEW_VTID,vt_layer=$NEW_LAYER,vt_module=$NEW_MODULE \\"
      echo "      --update-env-vars VTID=$NEW_VTID,VT_LAYER=$NEW_LAYER,VT_MODULE=$NEW_MODULE"
    else
      # Apply labels
      gcloud run services update "$SERVICE" \
        --region "$REGION" \
        --update-labels "vtid=$NEW_VTID,vt_layer=$NEW_LAYER,vt_module=$NEW_MODULE" \
        --quiet 2>&1 | grep -v "Deploying" || true
      
      # Apply environment variables
      gcloud run services update "$SERVICE" \
        --region "$REGION" \
        --update-env-vars "VTID=$NEW_VTID,VT_LAYER=$NEW_LAYER,VT_MODULE=$NEW_MODULE" \
        --quiet 2>&1 | grep -v "Deploying" || true
      
      echo -e "  ${GREEN}✅ Labels and env vars applied${NC}"
      SERVICES_FIXED=$((SERVICES_FIXED + 1))
      
      # Emit event to OASIS
      emit_event "$SERVICE" "success" "$NEW_VTID" "$NEW_LAYER" "$NEW_MODULE" \
        "Cloud Run service updated with VTID labels and environment variables"
    fi
  fi
done

# Complete report
cat >> "$REPORT_FILE" << EOF

## Summary

- **Total Services:** $TOTAL_SERVICES
- **Services Fixed:** $SERVICES_FIXED
- **Services Needing Attention:** $SERVICES_NEED_ATTENTION
- **Mode:** $([ "$FIX" = true ] && echo "FIX" || echo "AUDIT ONLY")

## Next Steps

EOF

if [ $SERVICES_NEED_ATTENTION -gt 0 ]; then
  cat >> "$REPORT_FILE" << EOF
### Services Requiring Manual VTID Assignment

The following services need manual VTID assignment:

1. Review each service marked with "needs_attention"
2. Assign proper VTID using pattern: PREFIX-LAYER-NUMBER
3. Run this script again with --fix to apply labels

Example:
\`\`\`bash
# After assigning VTID manually, update the inference rules in this script
# Then run:
./scripts/phase2c-audit-cloud-run.sh --fix
\`\`\`
EOF
fi

cat >> "$REPORT_FILE" << EOF

### Verify Labels

\`\`\`bash
# Check a specific service
gcloud run services describe <service-name> --region $REGION --format="value(metadata.labels)"

# Check environment variables
gcloud run services describe <service-name> --region $REGION --format="value(spec.template.spec.containers[0].env)"
\`\`\`

### Future Deployments

All future deployments MUST include VTID labels. Use the guard script:

\`\`\`bash
./scripts/ensure-vtid.sh <service> <vtid> <layer> <module>

# Then deploy with the generated labels
gcloud run deploy <service> \\
  --region $REGION \\
  \$VTID_LABEL_FLAGS \\
  --source .
\`\`\`

---

**Report Generated:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")  
**VTID:** DEV-CICDL-0033  
**Phase:** 2C - Runtime Fabric Enforcement
EOF

echo ""
echo "=================================================="
echo -e "${GREEN}✅ Audit Complete${NC}"
echo ""
echo "📊 Summary:"
echo "  Total Services: $TOTAL_SERVICES"
echo "  Services Fixed: $SERVICES_FIXED"
echo "  Needs Attention: $SERVICES_NEED_ATTENTION"
echo ""
echo "📄 Report saved to: $REPORT_FILE"
echo ""

if [ "$FIX" = false ]; then
  echo -e "${YELLOW}ℹ️  This was an audit only. Run with --fix to apply changes.${NC}"
  echo "   ./scripts/phase2c-audit-cloud-run.sh --fix"
fi

if [ $SERVICES_NEED_ATTENTION -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}⚠️  $SERVICES_NEED_ATTENTION service(s) need manual VTID assignment${NC}"
  echo "   Review the report and update inference rules in this script"
fi

echo ""
