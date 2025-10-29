#!/bin/bash

# Cloud Run VTID Label Guard Script
# Ensures all Cloud Run deployments include required VTID labels
#
# Usage: ./scripts/ensure-vtid.sh <service-name> <vtid> <layer> <module>
# Example: ./scripts/ensure-vtid.sh vitana-gateway DEV-CICDL-0031 CICDL GATEWAY

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SERVICE_NAME="${1:-}"
VTID="${2:-}"
LAYER="${3:-}"
MODULE="${4:-}"

echo -e "${BLUE}🛡️  Cloud Run VTID Label Guard${NC}"
echo "=================================================="

# Validate inputs
if [ -z "$SERVICE_NAME" ] || [ -z "$VTID" ] || [ -z "$LAYER" ] || [ -z "$MODULE" ]; then
  echo -e "${RED}❌ Missing required arguments${NC}"
  echo ""
  echo "Usage: $0 <service-name> <vtid> <layer> <module>"
  echo ""
  echo "Example:"
  echo "  $0 vitana-gateway DEV-CICDL-0031 CICDL GATEWAY"
  echo ""
  echo "Arguments:"
  echo "  service-name: Cloud Run service name"
  echo "  vtid:         Full VTID (e.g., DEV-CICDL-0031)"
  echo "  layer:        Layer code (e.g., CICDL, APIL, AGTL)"
  echo "  module:       Module name (e.g., GATEWAY, WORKER)"
  exit 1
fi

# Validate VTID format
if ! echo "$VTID" | grep -qE '^[A-Z]+-[A-Z]+-[0-9]+$'; then
  echo -e "${RED}❌ Invalid VTID format: $VTID${NC}"
  echo "   Expected format: PREFIX-LAYER-NUMBER (e.g., DEV-CICDL-0031)"
  exit 1
fi

# Validate layer is UPPERCASE
if echo "$LAYER" | grep -q '[a-z]'; then
  echo -e "${RED}❌ Layer must be UPPERCASE: $LAYER${NC}"
  exit 1
fi

# Validate module is UPPERCASE
if echo "$MODULE" | grep -q '[a-z]'; then
  echo -e "${RED}❌ Module must be UPPERCASE: $MODULE${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Service:${NC} $SERVICE_NAME"
echo -e "${GREEN}✅ VTID:${NC}    $VTID"
echo -e "${GREEN}✅ Layer:${NC}   $LAYER"
echo -e "${GREEN}✅ Module:${NC}  $MODULE"
echo ""

# Check if service exists
echo -e "${BLUE}🔍 Checking if service exists...${NC}"
if gcloud run services describe "$SERVICE_NAME" --region us-central1 --format="value(metadata.name)" &>/dev/null; then
  echo -e "${GREEN}✅ Service found: $SERVICE_NAME${NC}"
  
  # Get current labels
  echo -e "${BLUE}🏷️  Current labels:${NC}"
  gcloud run services describe "$SERVICE_NAME" --region us-central1 --format="value(metadata.labels)"
  echo ""
else
  echo -e "${YELLOW}⚠️  Service not found (will be created)${NC}"
  echo ""
fi

# Generate label flags
LABEL_FLAGS="--labels vtid=${VTID},vt_layer=${LAYER},vt_module=${MODULE}"

echo -e "${BLUE}🏷️  Label flags to use:${NC}"
echo "  $LABEL_FLAGS"
echo ""

# Export for use in deploy scripts
export VTID_LABEL_FLAGS="$LABEL_FLAGS"

echo -e "${GREEN}✅ VTID guard passed!${NC}"
echo ""
echo -e "${YELLOW}📋 Use these flags in your gcloud run deploy command:${NC}"
echo "  gcloud run deploy $SERVICE_NAME \\"
echo "    --region us-central1 \\"
echo "    $LABEL_FLAGS \\"
echo "    ..."
echo ""
echo -e "${YELLOW}Or use the exported variable:${NC}"
echo "  gcloud run deploy $SERVICE_NAME \\"
echo "    --region us-central1 \\"
echo "    \$VTID_LABEL_FLAGS \\"
echo "    ..."
echo ""

# Return success
exit 0
