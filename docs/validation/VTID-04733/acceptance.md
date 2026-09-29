# VTID-04733 — What's New card automation (gateway half)

`POST /api/v1/scheduled-notifications/whats-new` (daily 16:00 UTC via
EventBridge, `scripts/aws/setup-eventbridge-whats-new.sh`) reads the
PRODUCTION frontend's `/whats-new.json` and publishes at most one new
"Brand New Feature" card + push per run.

- AC-1: publishes the oldest fresh unpublished entry tenant-wide, notifies every member per locale.
- AC-2: never twice (entry id recorded in `created_by`), never stale (>14 days), max one per 20 h.
- AC-3: kill switch `WHATS_NEW_AUTOPUBLISH=false`; unreachable manifest or failed dedupe lookup publishes nothing.
  TEST: npx jest test/scheduled-notifications-whats-new.test.ts (services/gateway)

Not run against staging: the route writes a card and pushes to real members
(staging shares the production Supabase project), so per rule 48 it is proven
by the Jest suite above; staging only checks the gateway is alive.
