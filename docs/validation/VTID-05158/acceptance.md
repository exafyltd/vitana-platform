# VTID-05158 — acceptance (Health Hub Phase 1 / A1)

Scope: the sparred plan's work package A1 (`plan-sparring.md`, Changes 1–4). A2 (gateway service) and A3 (vitana-v1)
are separate VTIDs. **Nothing deploys:** no file under `services/gateway/**` changes; the store migration is applied
nowhere by merge (Aurora only — 0T first, production after the cutover); the `erase_user_data()` fix migration is a
production DB change applied to Supabase only after its own Gate 2.

AC-1 The store migration creates the catalogue, the partitioned tiers (5-minute daily; hourly, daily, records, batches,
quarantine monthly), the maintenance log, the read/withdrawal indexes, RLS and the store functions, and is idempotent.
TEST: scripts/ci/sql-tests/run-health-store-test.sh (applies the migration twice; §1 partitions attached, parent's exact column types/typmods, no DEFAULT partition, today−30 … today+30 and 2025-07 … now+3 months; second ensure creates nothing) — outputs/sql-health-store.txt

AC-2 Placement guard: refuses a database with both `auth.users` and `storage.objects` (Supabase) and rolls back; applies
with an `auth.users` stub alone and with `vitana.health_store_target = 'aurora'`. The migration carries the round-1 F5
comment about a future Aurora `auth.users` shim.
TEST: run-health-store-test.sh steps 2a–2c ("PASS vtid-05158 placement guard") — outputs/sql-health-store.txt

AC-3 Ingest: replace idempotency (same content twice → `duplicate`, store hash unchanged), `updated` on new content,
`deleted`/`not_found`, misaligned or wrong-kind items `invalid`, chunk > 2,000 refused; hourly and daily rollups for a
sum and a stats code; series older than 30 days go straight to the hourly tier; daily attribution in the member's time
zone on the Europe/Berlin DST day; best-ranked source wins in `health_series_daily_resolved`.
TEST: vtid-05158-health-store.test.sql §3–§6, §8 — outputs/sql-health-store.txt

AC-4 Purge drops only expired 5-minute partitions, removes batch/quarantine rows older than 30 days, hard-deletes rows
suppressed more than 7 days ago, keeps lifetime partitions and tomorrow's partitions, and writes one maintenance-run row.
TEST: vtid-05158-health-store.test.sql §11 — outputs/sql-health-store.txt

AC-5 Suppression primitives (S9): per category and per source across all four tiers; suppressed rows are invisible to
the member (RLS) and to the resolver; a write onto a suppressed key does not resurrect it; unsuppress restores.
TEST: vtid-05158-health-store.test.sql §10 — outputs/sql-health-store.txt

AC-6 RLS and grants: a member reads only own, un-suppressed rows and cannot INSERT/UPDATE/DELETE; batches, quarantine
and partitions are not readable by a member (also under Supabase-style default privileges); `anon` reads nothing;
every store function is SECURITY DEFINER and executable by `service_role` only.
TEST: vtid-05158-health-store.test.sql §9 (mutation: removing the partition REVOKE or the RLS suppressed filter turns it red) — outputs/sql-health-store.txt

AC-7 `erase_user_data()` removes a member's rows from the child partitions of every tier and the batch/quarantine
tables, leaves another member's rows, and none of the store tables is in `erasure_registry`.
TEST: vtid-05158-health-store.test.sql §12 — outputs/sql-health-store.txt

AC-8 Aurora-safe `erase_user_data()` (Change 1m): identical to VTID-04765 except `to_regclass('auth.users')`; the
existing with-stub test passes unchanged after the new migration; on a database without an `auth` schema it runs (dry
run and real), erases a plain and a partitioned table and returns empty `errors`; without the fix that variant fails
with `relation "auth.users" does not exist`.
TEST: scripts/ci/sql-tests/run-erase-user-data-test.sh (both PASS lines; CI SQL-ERASE-USER-DATA greps both) — outputs/sql-erase-user-data.txt, outputs/sql-erase-no-auth-users-red-before-fix.txt

AC-9 Aurora-only drift guard: the eight store tables are `aurora_only_tables` (VTID + reason); MIGRATION-DRIFT-CHECK
does not report them missing from Supabase and FAILS if any appears there; a non-listed missing table still fails;
`--update-baseline` keeps the list.
TEST: node --test scripts/ci/check-migration-drift.test.cjs (7 tests incl. the CLI on a synthetic snapshot) — outputs/node-tests.txt

AC-10 Capacity model and placement record: the published tables equal `scripts/health/capacity-model.mjs` output;
owner-confirmed inputs (S/M/L at 40%, four triggers) pinned; placement decision Aurora recorded with reasons and triggers.
TEST: node --test scripts/health/capacity-model.test.mjs — outputs/node-tests.txt, outputs/capacity-model.md

AC-11 Existing guards stay green: every gateway Jest suite that scans `supabase/migrations` (definer lockdown, role
separation, operator and support pipelines, …), the drift parser suite, and every `scripts/**` node test (UNIT.yml).
TEST: outputs/jest-migration-scanning-suites.txt (31 suites, 574 tests), outputs/unit-all-script-tests.txt

AC-12 `DATABASE_SCHEMA.md` documents both migrations as "committed, NOT applied", the Aurora-only target and the
`health.store.*` OASIS namespace; `docs/programs/health-hub/STATUS.md` lists A1–A3.
TEST: review of DATABASE_SCHEMA.md (change-log row + "Health Hub store" section)

## Staging

A1 changes no gateway deploy path (`node scripts/ci/staging-verify/run.mjs check-pr` reports nothing deploys), so there
is no STAGING-VERIFY run and no Gate 2 for the store. `staging-tests.json` names the existing drift-parser suite with
that reason. The `erase_user_data()` fix migration gets its own Gate 2 before it is applied to Supabase (evidence: both
SQL-ERASE-USER-DATA variants green and a read-only `pg_get_functiondef` diff showing only the Change 1m clause).

## Decisions taken (inside the approved plan)

1. Placement guard trips only when **both** `auth.users` and `storage.objects` exist. The plan's sentence says "unless
   … neither exists", but its own test list requires that "an `auth.users` stub alone does not trip it"; the guard
   follows the test (Supabase has both, so it is still refused). The F5 comment is kept verbatim.
2. RLS read policy is `user_id = auth.uid() AND suppressed_at IS NULL` (plan: `user_id = auth.uid()`), so suppressed
   rows are unusable at once on every path, matching Change 6/S4.
3. `health_store_ensure_partitions` keeps the plan's ranges but skips a 5-minute/batch/quarantine partition the purge
   would drop at once (wholly older than 30 days), so the hourly ensure → purge run does not create and drop tables.
4. `health_ingest_batches` is partitioned on `received_month` (a unique key must contain the partition key) with a
   CHECK tying it to `received_at`; it also stores per-sample `results` (no values) for S3 batch replay.
5. `health_store_ingest` input: deletions are items with `"op":"delete"` in `p_series`/`p_records` (the plan's
   signature has no separate deletions argument); it returns `invalid` for a misaligned/malformed item and `suppressed`
   for a key under withdrawal (never overwritten) — A2 maps both onto S3 statuses.
6. Catalogue seed (20 codes): activity, sleep, heart, body, habits; blood pressure is seeded with
   `catalogue_allowed = false` (outside the §2 pattern catalogue); no lab codes (Phase 5); a CHECK forbids
   glucose/CGM/HbA1c keys. `source_rank`: smaller is better. No CHECK on `source_kind` (B1 owns the kinds).
7. The drift-check unit test is a new node:test file in `scripts/ci/` (runs in UNIT.yml) rather than an extension of the
   gateway Jest suite, so A1 touches no gateway deploy path.
8. Capacity tables are the script's output; where they differ from the plan's hand-rounded table it is rounding only
   (listed in the placement record).
