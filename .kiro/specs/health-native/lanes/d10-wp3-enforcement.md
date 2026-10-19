---
lane: d10-wp3-enforcement
state: ready
next_actor: kiro
vtid: VTID-05094
depends_on: [d10-consents]
executor: kiro
reviewer_seat: exafyltd
paths:
  - "services/gateway/src/**"
  - "services/gateway/test/**"
  - "supabase/migrations/**"
  - "scripts/ci/sql-tests/**"
  - "DATABASE_SCHEMA.md"
  - "docs/programs/health-hub/**"
  - "docs/validation/**"
updated: 2026-10-15T18:59Z
---
# D10 WP3 — consent enforcement E1–E8 and quarantine release (gateway)

Tasks: `tasks.md` section "d10-wp3-enforcement".

VTID-05094 is already allocated under the sparred D10 plan: `docs/validation/VTID-05092/plan-sparring.md`
(on #4100's branch `claude/health-data-integration-plan-dbxyld-d10w1` until it merges) — section 7 "Enforcement
points" lists E1–E8 with exact call sites, the consent categories each needs and the behaviour without consent
(E1 partner ingestion, E2 connector webhooks, E3 wearable connect/callback, E4 `executeGetWearableMetrics`, E5 ORB
`tool_get_lab_results`, E6 `user-health-context`, E7 wearable analyzer batch, E8 automation handlers). Build the enforcement points E1–E8 listed there on top of WP1's
`health_consent_categories` API: every reader/writer of health data checks the member's per-category consent;
withdrawal stops processing and releases/purges quarantined data as specified. Ships dark if the plan says so.
Unit + integration tests (local Postgres) only — no writes to staging/production. This lane is a prerequisite for
turning on `WEARABLE_FEATURE_BRIDGE_ENABLED` (D6a) and `HEALTH_SYNC_INGEST_ENABLED` (C1).

## Log
### 2026-10-15T18:59Z · session_01VuZPi9pvHaUverAXRC1WvU · (backfill) → ready
Handed over to Kiro with the health-native spec. next_actor: kiro.
