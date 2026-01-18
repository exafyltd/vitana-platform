#!/bin/bash
# Create OASIS Task for VTID-01188: Infinite Scroll List Layout
# Run this script locally to create the task in Command Hub

GATEWAY_URL="${GATEWAY_URL:-https://gateway-q74ibpv6ia-uc.a.run.app}"

curl -X POST "${GATEWAY_URL}/api/v1/oasis/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "VTID-01188: Infinite Scroll List Layout - OASIS Events & VTID Ledger",
    "layer": "DEV",
    "module": "FRONTEND",
    "status": "scheduled",
    "summary": "Implement 3-row layout standardization and infinite scroll for OASIS Events and VTID Ledger screens.\n\n## Changes Required\n\n### OASIS Events\n- REMOVE: Auto-refresh toggle row (redundant with Row 1)\n- REMOVE: LIVE indicator row (redundant with Row 1)\n- MOVE: Topic + Status filters to Row 3 toolbar inline\n- ADD: Item count to Row 3\n- ADD: Infinite scroll with Load More button\n- ADD: Pagination state management\n\n### VTID Ledger\n- REMOVE: VTID Ledger title (tab already shows this)\n- REMOVE: View label (OASIS_VTID_LEDGER_ACTIVE)\n- REMOVE: Description text\n- MOVE: Count to Row 3 toolbar\n- FIX: Make table rows CLICKABLE (critical bug)\n- ADD: Detail drawer on row click\n- ADD: Infinite scroll with Load More button\n\n## Target Layout (Both Screens)\nRow 1: Global top bar (AUTOPILOT | OPERATOR | PUBLISH ... LIVE | refresh) - UNCHANGED\nRow 2: Tab navigation - UNCHANGED\nRow 3: Toolbar (filters left + count right)\nThen: Table with sticky headers + scrollable list + Load More\n\n## Full Spec\nSee: docs/specs/SPEC-infinite-scroll-list-layout.md\n\n## Files to Modify\n- services/gateway/src/frontend/command-hub/app.js\n- services/gateway/src/routes/events.ts\n- services/gateway/src/routes/oasis-vtid-ledger.ts"
  }'

echo ""
echo "Task created. Check Command Hub for the new task card."
