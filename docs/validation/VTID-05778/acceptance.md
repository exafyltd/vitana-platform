# VTID-05778 — own GATE-INVARIANTS under the loop catalog

AC-1: The scheduled workflow GATE-INVARIANTS is owned by exactly one loop (L5 Guard).
TEST: services/gateway/test/loop-catalog.test.ts :: workflows: no orphans, nothing owned twice, no dangling names
Status: red on main (`Expected: 29`, `Received: 28`); passes with the one-line catalog change.

AC-2: The service reports the same clean coverage for the registries compiled into the gateway.
TEST: services/gateway/test/loop-catalog.test.ts :: the service reports the same clean coverage for the registries compiled into the gateway
Status: red on main; passes with the change.

AC-3: Nothing else in the catalog changes.
TEST: services/gateway/test/loop-catalog.test.ts (all other assertions unchanged)
Status: unchanged assertions pass on the head.

ROUTE_MOUNT: services/gateway/specs/loop-catalog-v1.json — loop L5, sensors.workflows
FINAL_URL: https://preview-aws-gateway.vitanaland.com/alive
CURL_PROOF: pending — the staging probe in staging-tests.json runs after the staging deploy of this merge.
