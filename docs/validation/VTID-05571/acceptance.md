# VTID-05571 — mt-data-cleanup-r2 / orphan-analysis-and-quarantine

Plan: `.kiro/specs/mt-data-cleanup-r2/plan.md` (Re-plan answers, premises 1-3 and 7-8, Fix item 1) and the
`orphan-analysis-and-quarantine` group of `tasks.md` (O1-O9). Sparring record: `plan-sparring.md`.

VALIDATION_PROFILE: database (migration files and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR; each file is applied later through
`RUN-MIGRATION.yml`, one dispatch per file, after the owner approves the files and the target database
(collaboration.md §7d). Kiro ran no SQL against any live system; the local runs below are in-process PGlite.

## Files

| Task | File |
|---|---|
| O1 read-only analysis, helpers | `supabase/migrations/20261102040000_vtid_05571_orphan_analysis.sql` |
| O2 snapshots, O3 quarantine table | `supabase/migrations/20261102040100_vtid_05571_orphan_quarantine_snapshots.sql` |
| O4 move logic (functions only) | `supabase/migrations/20261102040200_vtid_05571_orphan_move_logic.sql` |
| O4 apply (snapshot, move, assert) / O5 rollback | `20261102040300_vtid_05571_orphan_cleanup_run.sql` / `…_cleanup_rollback.sql` |
| O8 repoint (gate + 19 writers) / its rollback | `20261102040400_vtid_05571_writer_repoint.sql` / `…_writer_fallback_rollback.sql` |
| O7/O8 pgTAP | `supabase/tests/vtid_mt_data_cleanup_orphan_quarantine.test.sql` (47), `…_orphan_writer_repoint.test.sql` (40); the quarantine file now has 50 cases |
| O6 read-only checks | `pre-check.sql`, `post-check.sql`, `rollback-check.sql`, `repollution-check.sql` |
| O9 | `docs/multitenancy/MIGRATION-QUEUE.md` rows 21-25; `scripts/ci/migration-drift-baseline.json` (+5 not-yet-live tables) |

Apply order: 040000 → 040100 → 040200 → 040300 (cleanup) → 040400 (repoint). Rollback files sort before their forward
files, so a full replay runs them first as a no-op (same convention as VTID-05466/05467).

## Acceptance

AC-1 `analyze_orphan_rows()` is read-only: it is `STABLE` (PostgreSQL rejects writes), a pgTAP case counts rows before and
after, and EXECUTE is service_role only. It splits `…0001` as dev tenant from `…0001` as bot and reports `…0099`.
TEST: pgTAP cases 1-12.

AC-2 Snapshot first: the move refuses a row that is not in `bak_mt_data_cleanup_<table>`; a second snapshot never overwrites.
TEST: pgTAP cases 13-18.

AC-3 `…0099` rows (also in a live tenant) land in `mt_orphan_quarantine` (`dev_user_test_data`) and in no live tenant; a bot
row with a real tenant is untouched; a bot row with `tenant_id = …0001` is quarantined as `bot_sender_dev_tenant`
(R3-F1); a single-membership owner (and the fake 550e8400 tenant) is remapped; 0 and 2+ membership owners and an
unattributable cross-tenant DM are quarantined, never remapped to a live tenant.
TEST: pgTAP cases 19-35.

AC-4 Re-pollution check reads 0 after the move; a second run moves nothing; a row that cannot move is kept and recorded
as `move_blocked`.
TEST: pgTAP cases 36-41; `repollution-check.sql`.

AC-5 Rollback restores the snapshot row for row and clears the lane's quarantine rows.
TEST: pgTAP cases 42-50;
`rollback-check.sql`.

AC-6 Repoint (O8): gate RAISEs on a fixture with the column but zero primary rows, on an empty `user_tenants` while `auth.users` has accounts, and on a partial backfill (< 95% of `auth.users` with a primary row), and passes only on a fresh stack (both empty) or full coverage; for each of the 19 functions a caller
with one primary row writes that tenant, callers with 0 and with 2 primaries fail closed (`TENANT_UNRESOLVED`; the
`uuid` writer returns NULL; `d45_acknowledge_window` resolves the tenant before its UPDATE and returns the same JSON error, leaving the window unacknowledged) and write no `…0001` row;
the five 01127 functions with a NULL `auth.uid()` return `UNAUTHENTICATED` and write no `…0099` row; no body contains
either literal; ACL, SECURITY mode and search_path are unchanged.
TEST: `…writer_repoint.test.sql` cases 1-47.

## Deviations and limits (honest record)

* Decision (fix-forward 1, reviewer finding on head 16d19fe8c3): a group message has `receiver_id` NULL and `group_id` set
  (VTID-03089, `20260525000000_VTID_03089_chat_groups.sql:40-51`). The cross-DM test compared the NULL peer, evaluated to NULL,
  and the row got decision `remap` with a NULL `target_tenant`. A NULL peer is now explicitly NOT a cross-tenant DM
  (`t.<peer> IS NOT NULL` in `mt_orphan_classified_sql`), so a group message on an orphan tenant follows its sender: a sender
  with one membership is remapped to that tenant; 0 / 2+ memberships and bot/dev senders keep their existing decisions
  (quarantine). Most conservative option chosen: `chat_groups.tenant_id` is NOT used (the group may itself sit on an orphan
  tenant, and it is not in the registry). Tests: group message C6 (pgTAP 35, 36, 47), harness `chat_messages` now matches
  production (`receiver_id` nullable, `group_id`, DM-xor-group check). RED on 16d19fe8c3: `outputs/pgtap-orphan-quarantine-group-message-RED-on-16d19fe8c3.txt`
  (4 not ok); GREEN: `outputs/pgtap-orphan-quarantine.txt` (50/50). No existing assertion was loosened; the one count that
  the new row legitimately changes (rollback restores 4 -> 5 chat_messages under ...0001) was updated with the row.
* Local runs are PGlite (PG 18 wasm) with a pgTAP-compatible shim and stand-in tables (`pglite-harness/`), loading the REAL
  legacy writer migrations unmodified. The full production schema and real pgTAP (`supabase test db`) were not available in
  this sandbox (no docker, psql, supabase CLI): CI's pgTAP run is authoritative.
* The gate passes on a completely empty `user_tenants` only when `auth.users` is also empty or absent (a fresh local stack applies
  every migration to an empty database and must still build). On a database with accounts it RAISEs on an empty store, on rows
  without any primary, and when fewer than 95% of `auth.users` own a primary row. The cleanup file likewise only refuses an
  empty `user_tenants` when orphan rows have owners.
* Dev-user `…0099` rows are deleted from live tenants as well, by design. The owner sizes them from `pre-check.sql` before approving row 24.
* The `bak_mt_data_cleanup_*` snapshots are kept 30 days after the row 24 apply, then dropped (see MIGRATION-QUEUE.md).
* Batches: a migration file is one transaction; the move runs each row in a sub-transaction, batches of up to 5,000, with
  `lock_timeout` 3s and 5 retries per batch. At the plan's volume (~1.5k orphan rows) that is one batch per table.
* `availability_config` is seeded by 01127 with `tenant_id = …0001` and no owner: it is quarantined (`no_owner`) and restored
  by the rollback.
* Reasons for the gateway engines (R3-F2) are lane `engine-tenant-fallbacks`; this lane does not claim them.
