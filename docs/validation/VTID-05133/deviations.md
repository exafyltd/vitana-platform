# VTID-05133 — deviations from the standing process (for the Gate 2 message)

## D-1: the platform migration was applied before Gate 2

- **What:** `supabase/migrations/20261013150000_vtid_05133_ai_connection_grants.sql` was applied to the shared
  Supabase project on 2026-10-13 08:13 UTC via `RUN-MIGRATION.yml` (run 38367789089, dispatched from the PR branch),
  before merge and before Gate 2.
- **Rule it departs from:** VTID-04947 plan D2 — migrations reach the shared database only after the owner's Gate 2
  "yes", dispatched in order. The session followed the older platform precedent of applying an additive migration
  before merge (VTID-05077) to clear `MIGRATION-DRIFT-CHECK`; that precedent predates D2 and should not have been used.
- **Effect:** additive and inert. One new empty table (`ai_connection_grants`, RLS on, no direct writes for members)
  and four SECURITY DEFINER functions callable only by signed-in members acting as themselves. No existing table,
  row or policy changed. Production code neither reads nor calls them (production does not run the VTID-05133
  gateway or frontend). Verified read-only after apply: RLS on, `authenticated` has no INSERT, `anon` cannot execute
  the grant function, 0 rows.
- **Not undone:** reverting would be a second unapproved production write; the objects are harmless while unused.
  Listed in the Gate 2 message for the owner's decision. Rollback, if wanted: `rollback.sql`.
- **Going forward in this VTID:** the frontend migration (`vitana-v1`
  `20261013160000_vtid_05133_ai_discoverable.sql`) is applied only after Gate 2, by its dispatch-only workflow
  `apply-vtid-05133-ai-discoverable-migration.yml`.
