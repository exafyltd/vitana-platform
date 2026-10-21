---
lane: phase1-data-core
state: in-review
next_actor: kiro
vtid: VTID-05159
depends_on: [d10-consents]
executor: claude
reviewer_seat: claude
paths:
  - "services/gateway/src/**"
  - "services/gateway/test/**"
  - "supabase/migrations/**"
  - "scripts/ci/sql-tests/**"
  - "DATABASE_SCHEMA.md"
  - "docs/programs/health-hub/**"
  - "docs/validation/**"
updated: 2026-10-21T09:42Z
---
# Phase 1 data core — A2, B2, B3, C1, C2 (gateway)

Tasks: `tasks.md` section "phase1-data-core".

PRs (vitana-platform): #4105 A2 ingest/reader/maintenance (VTID-05159), #4107 C1 Health Sync contract v1 + ingest
adapter + sync consent keys + phone connectors (VTID-05164), #4109 B2 writer dual-write + `health_features_daily_v2`
(VTID-05162), #4111 B3 Vitana Index dual-compute + cutover switch (VTID-05163, base = B2 branch), #4110 C2 wellness
context skeleton + purpose-boundary tests (VTID-05165, base = C1 branch). All ship dark.

Every one is green except `drift` (the consent-categories migration they carry or depend on). Merge order after
`d10-consents`: A2 → C1 → B2 → B3 → C2; refresh stacked PRs from their base branch. A1/B1 store tables are Aurora-only
(apply on 0T, then production after the Aurora cutover).

## Log
### 2026-10-15T18:59Z · session_01VuZPi9pvHaUverAXRC1WvU · (backfill) → in-review
Handed over to Kiro with the health-native spec. next_actor: owner.
### 2026-10-21T09:41Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:42Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
