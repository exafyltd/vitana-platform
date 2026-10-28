# Vitana Frontend – Canonical Source Definition
# GOV-FRONTEND-CANONICAL-SOURCE-0001

## Canonical Source Directory
The ONLY valid and approved source for the Command Hub frontend is:

services/gateway/src/frontend/command-hub/

No other directory may contain:
- index.html
- styles.css
- app.js
- Any Command Hub UI files

## Build Output Directory
Build artifacts MUST exist only in:

services/gateway/dist/frontend/command-hub/

## Forbidden Actions
- Creating sibling or shadow directories
- Creating alternate command-hub paths
- Moving the source
- Deleting backups or safety artifacts
- Modifying Express static mounts

## Deployment Rules
Deployment always via:

cd ~/vitana-platform/services/gateway
npm run build
cd ~/vitana-platform
./scripts/deploy/deploy-service.sh gateway services/gateway

## Governance
This directory is protected under:
GOV-FRONTEND-CANONICAL-SOURCE-0001
