# VTID-05573 - mt-network-r2 / legacy-messages-migration-db

Plan: `.kiro/specs/mt-network-r2/plan.md` and the `legacy-messages-migration-db` group of `tasks.md` (tasks 1-4). Sparring
record: `plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR (acceptance is written first; the evidence sections below
are filled when the code is green).

## Acceptance

AC-1 Before anything moves, the four legacy tables (and the two participant tables) are frozen against client and service
writes and copied whole into `bak_*` tables (RLS on, no client grant, 30-day retention note).
TEST: pgTAP cases 3-10 and pglite-harness/checks.sh (freeze).

AC-2 Every legacy message is mapped by the single D15 rule: two people who share a non-platform tenant -> community, tenant =
the shared tenant (their shared primary if several); otherwise network, tenant_id = the sender's context tenant. Groups:
all members share a tenant -> community group of it, else a network group flagged `legacy_scope = network`.
TEST: pgTAP cases 11-35.

AC-3 Rules 43-45: a message to or from a service bot / notification test actor / platform-only account is not migrated, such an
account is never a migrated group member, and the platform tenant is never written on member content.
TEST: pgTAP cases 15, 31, 34, 38, 39.

AC-4 The migration is idempotent and balanced: re-running adds no row, and per source total = migrated + skipped_excluded +
unplaced; the drop file refuses unless unplaced is 0 and every classified row is present.
TEST: pgTAP cases 41-45 and pglite-harness/checks.sh (drop refusal).

AC-5 The four legacy tables are dropped by the last file only; rollback restores them with exact row counts from `bak_*`,
removes the migrated rows, and refuses when a migrated group already received new messages.
TEST: pglite-harness/checks.sh (rollback-check.sql) and cases 1-2.

AC-6 No bare `current_tenant_id()` policy is added; the migration functions are SECURITY DEFINER with a pinned search_path and
EXECUTE for service_role only.
TEST: pgTAP cases 46-47 and the bare-policy lint (jest services/gateway/test/mt-identity-bare-policy-lint.test.ts).

## Files

| Step | File |
|---|---|
| 1 freeze + snapshot `bak_*` | `supabase/migrations/20261102052000_vtid_05573_legacy_messages_snapshot_freeze.sql` |
| 2 D15 helpers, `mt_legacy_messages_migrate()`, `mt_legacy_messages_assert_ready()` | `supabase/migrations/20261102052100_vtid_05573_legacy_messages_functions.sql` |
| 3 the data move | `supabase/migrations/20261102052200_vtid_05573_legacy_messages_migrate_run.sql` |
| 4 drop the four legacy tables (guarded) | `supabase/migrations/20261102052300_vtid_05573_legacy_messages_drop.sql` |
| rollbacks (this order) | `rollback-052300-drop-legacy.sql`, `rollback-052200-migrated-rows.sql`, `rollback-052100-functions.sql`, `rollback-052000-snapshot-freeze.sql` |
| read-only pre/post row-count checks | `live-before.sql`, `post-apply-checks.sql`, `rollback-check.sql` |
| pgTAP (50 cases) | `supabase/tests/mt-network-legacy-migration.pgtap.sql` + `pgtap/vtid_05573_fixture.sql` |

Apply order: 052000, 052100, 052200, 052300, one RUN-MIGRATION dispatch per file, after the owner approves the files and the
target database (collaboration.md 7d). Prerequisites already on `main`: `20261102050000` (VTID-05576, `chat_messages.scope`)
and `20261102051000` (VTID-05582, `is_network_excluded_account`). MIGRATION-QUEUE position: after the `mt-network-r2`
network-visibility rows (051000/051100), before `matching-intent-scope-db` (053xxx); the queue row is a platform-side follow-up
(`docs/multitenancy/MIGRATION-QUEUE.md` is outside this lane's paths). Apply 052300 only after the gateway/v1 readers of the
legacy tables are gone.

## Evidence (all in-process PGlite, PostgreSQL 18 wasm, with a pgTAP-compatible shim)

- RED on `origin/main` state (fixture + the two dependency migrations, no lane file): `outputs/red-origin-main.txt`, committed
  before any migration. RED with only the functions file: `outputs/red-functions-only.txt` (21 of 50 fail).
- GREEN: `outputs/green-run1.txt` (50 ok), `outputs/green-run2-twice.txt` (applied twice, 50 ok).
- Five mutations each turn the file red; restored -> 50 ok: `outputs/mutations.txt`.
- Read-only checks, freeze, the two refused drops, rollbacks (one refused), `rollback-check.sql` exact-row restore, re-apply:
  `outputs/checks.txt`.
- `node scripts/ci/bare-policy-lint.mjs`: 0 bare policies (this lane adds no policy); jest `mt-identity-bare-policy-lint` 8 pass;
  `node --test scripts/ci/check-migration-drift.test.cjs` 8 pass. `scripts/ci/migration-drift-baseline.json` is not touched
  (count stays 120 = `len(known_missing_tables)`): the `bak_*` tables are created by dynamic SQL, like VTID-05571's on-demand
  snapshots, because they exist only where the source table exists.
- NOT run here: real pgTAP on a Supabase stack and the full production schema (no docker/psql/supabase CLI). CI is authoritative.

## Decisions taken (most conservative option inside the plan)

- **Timestamps 20261102052000-052300**, not the briefing's 061000-061900: the lane's Lane-scope glob is `20261102052***`.
- **Cross-tenant legacy group threads** (no `chat_groups.scope` column until `network-groups-db`): migrated as chat_groups rows
  with `metadata.legacy_scope = 'network'`, tenant = the creator's context tenant, members only the thread's participants
  (read stays participant-only, the D27 interim state). Their messages are written `scope = 'network'` through the
  VTID-05576 scope guard's transaction-local flag. `network-groups-db` backfills `chat_groups.scope` from that flag.
- **Participant tables** (`thread_participants`, `global_thread_participants`) are snapshotted but not dropped: they are outside
  the four tables, and their FKs onto `message_threads` are dropped by catalog lookup before the drop. The tables are dropped
  WITHOUT CASCADE so any other dependent object makes the drop fail loudly.
- **Rules 43-45**: a message to/from a listed account, and a listed account as group member, are not migrated (kept in `bak_*`);
  counted as `skipped_excluded` in the reconcile figures.
- **Shared tenant**: "their shared primary if several" is implemented as the non-platform tenant all people share, ordered by
  `is_primary` then id; for a group, the tenant all members share. The platform tenant is never written on member content.
- **Unplaceable rows** (no sender, no recipient/thread, no tenant at all) are never silently dropped: the drop file refuses.
- **Rollback of the legacy tables** restores rows and RLS-on with service_role-only access; the v1 policies and publication
  membership return with a replay of the v1 migration chain (stated in the rollback file). The snapshots are kept 30 days.
- **Backfill triggers**: live triggers on the target tables would fire on the data move; `live-before.sql` lists them for the
  owner to review before apply (no trigger on these tables exists in the migration tree besides the scope guard).
