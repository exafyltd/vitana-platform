# Owner packet: VTID-05569 (queue rows 57 and 58, migration 043000), NOT NULL tenant_id assertion

Lane: `mt-data-cleanup-r2/hot-tables-not-null-expand-contract`, state `done`, seat hotmail. Prepared by session
`kiro-hotmail-202611061752-cc1f` (M0 directive stream S1), base `origin/main` `6dc6e1ba0c`.

**Nothing in this packet has been applied.** No `RUN-MIGRATION.yml` was dispatched, no live database was contacted. Every "ran"
below is an in-process PGlite run whose raw output is in this folder.

## 1. What you are asked to approve (collaboration.md §7d, `.claude/rules/collaboration.md:307-322`)

| Queue row | File (under `supabase/migrations/`) | Kind |
|---|---|---|
| 57 | `20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql` | read-only assertion, no DDL, no data change (`MIGRATION-QUEUE.md:75`) |
| 58 | `20261102043100_vtid_05569_hot_tables_tenant_not_null_assert_rollback.sql` | the rollback of row 57, a no-op (`MIGRATION-QUEUE.md:76`) |

`acceptance.md:29,55,71` still say rows 51-52; the queue renumbered them to 57-58 (`MIGRATION-QUEUE.md:75-76`, `:104`). The queue is
authoritative.

**Target database: you name it.** `RUN-MIGRATION.yml` takes `target` = `default | supabase | aurora`
(`.github/workflows/RUN-MIGRATION.yml:11-16`); `default` follows the repo variable `MIGRATION_TARGET`, unset = `supabase`
(`:42-66`). The dispatching Kiro session reads it, states the resolved database and passes `target` explicitly
(`collaboration.md:316-318`). This session could not read the variable (HTTP 403), so the value is not stated here. It refuses
while `MIGRATION_FREEZE` is `true` (`:55-58`). Staging shares the production database (vitana-v1 `CLAUDE.md`).

The migration changes no data, but a dispatch on the `supabase` target is not write-free: `--record-migration` writes one audit row
per applied file to `supabase_migrations.schema_migrations` in the same request (`RUN-MIGRATION.yml:91-98`). That is the only write.

## 2. What it changes

Nothing in the schema and no row. There are no bare policies in this lane.

**Row 57** is one `DO` block in `BEGIN … COMMIT` with `lock_timeout 3s` and `statement_timeout 120s` (`...043000...sql:15-18,61`). For
each of `chat_messages`, `user_notifications`, `product_analytics_events` it RAISEs and so aborts the apply when:
- `tenant_id` is missing: `undefined_column` (`:42`);
- `tenant_id` is nullable per `information_schema`: `not_null_violation`, "re-plan the expand/contract (spec section 4.7), do not
  improvise" (`:45`);
- any row holds a `tenant_id` that is not in `public.tenants`: `foreign_key_violation`, "run the orphan quarantine (VTID-05571)
  first" (`:49-53`).
Otherwise it prints one NOTICE per table (`:56`). It reads `tenants` through `tenant_id` and `id` when present (`:29-35`).
If the assertion fires, nothing is half-applied; the run fails and that is the information.

**Row 58** is a `DO` block with one NOTICE (`...043100...sql:9-17`). It must never drop NOT NULL.

Why only an assertion: all three columns are already `NOT NULL` in their original DDL, so no expand/contract is needed
(`acceptance.md:13-18`: `chat_messages` `20260225200000_chat_messages.sql:8`, `user_notifications`
`20260225000000_notification_system.sql:27`, `product_analytics_events`
`20260612140000_BOOTSTRAP_product_analytics_events.sql:33`). Whether production still matches that DDL is what row 57 checks.

## 3. Dry-run on PGlite

Command (repo root): `node docs/validation/VTID-05569/owner-packet-outputs/dry-run.mjs`. Exit 0. Raw output:
`owner-packet-outputs/dry-run.txt`. Script: `owner-packet-outputs/dry-run.mjs`.

| Part | What ran | Result |
|---|---|---|
| A. Replayed local stack (`scripts/mt/stack`, 425 applied, 308 skipped, 0 failed) | row 57 | **Refuses**: `public.chat_messages.tenant_id does not exist`. Expected and recorded: the replay skips `20260225200000_chat_messages.sql` (`publication "supabase_realtime" does not exist`), so `chat_messages` is never created there, and `replay-skip.json` lists row 57 as a skip for this reason. This run says nothing about production. |
| B. Lane stand-in schema (`pglite-harness/base_schema.sql` plus the real `product_analytics_events` DDL) | `pre-check.sql`; row 57; `post-check.sql`; row 57 again; row 58; `rollback-check.sql` | all PASS. pre-check: three tables `nullable NO`, `orphan_rows 0`; post-check `all_not_null true, no_orphans true, no_object_added true`; rollback-check `still_not_null true, nothing_left_behind true` |
| B2. Same stand-in with one `user_notifications` row on a tenant that does not exist | `pre-check.sql`; row 57 | pre-check shows `user_notifications | NO | 1`; row 57 refuses with the orphan message |
| B3. Same stand-in with `chat_messages.tenant_id` made nullable | `pre-check.sql`; row 57 | pre-check shows `nullable YES`; row 57 refuses with the nullable message |
| C. pgTAP `vtid_mt_data_cleanup_notnull_assert.test.sql` on the lane's pgTAP shim | 11 cases | 11 of 11 ok; same as the lane's `outputs/pgtap-green.txt` |

The lane's red runs (assertion removed, nullable check removed, orphan check removed) are in the lane's `outputs/`
(`acceptance.md:59-65`); I did not repeat them.

**What did not run, and why**
- Real pgTAP and the D11 Supabase local stack: no Docker or Postgres server. Part C is on a shim.
- No run touches the production schema. Parts B to C use a stand-in. Whether production's three columns are `NOT NULL` and carry
  zero orphans is exactly what the pre-check will answer on the target, and I could not ask it.
- The assertion has not run in a state where rows 21-25 and 41-42 have been applied, because none of them is applied (section 7).
  The orphan refusal in B2 is what it does without them.
- `pre-check.sql`, `post-check.sql` and `rollback-check.sql` ran on the stand-in only.

## 4. Pre-check (read only, before row 57)

`docs/validation/VTID-05569/pre-check.sql`: one row per table with `nullable` and `orphan_rows`.
Expected: `nullable = 'NO'` and `orphan_rows = 0` on all three rows. A row that differs means row 57 would RAISE: do not apply it,
and re-plan the expand/contract (`pre-check.sql:1-3`). This query is the whole dry-run for production. It is three `NOT EXISTS` counts over the full tables; I do not know the row
counts, and row 57 runs the same counts under `statement_timeout 120s`, so a very large table could time out there (the run then
fails and nothing changes).

## 5. Post-check (read only, after row 57)

`docs/validation/VTID-05569/post-check.sql`: three booleans, all must be `true`: `all_not_null`, `no_orphans`, `no_object_added`
(nothing named `*05569*` left in `public`). After row 58, `rollback-check.sql`: `still_not_null`, `nothing_left_behind`, both `true`.

## 6. Rollback

Rollback id: `20261102043100_vtid_05569_hot_tables_tenant_not_null_assert_rollback.sql` (row 58, a no-op: row 57 has no DDL and no
data change; `MIGRATION-QUEUE.md:75-76`). Running it only prints a NOTICE. There is nothing to restore. It runs only through
`RUN-MIGRATION.yml` on your approval of a rollback (`MIGRATION-QUEUE.md:76`). Dry-run: part B (row 58, then `rollback-check.sql`
both `true`).

## 7. Apply window

Preconditions from the queue, none of them met today (every one of these rows reads "queued (pending owner approval)",
`MIGRATION-QUEUE.md:39-43,55-57,59-60`):
- VTID-05571 rows 21-25 (orphan quarantine run) and VTID-05572 rows 41-42 (profiles backfill) applied first: "the assertion includes
  their zero-orphan state" (`MIGRATION-QUEUE.md:75`).
- The memory-facts merge, rows 37-39, also before (`MIGRATION-QUEUE.md:104`: rows 57-58 "run last in the mt-data-cleanup-r2 spec").
  Rows 21-25 depend on rows 14-16, the canonical `user_tenants` (`MIGRATION-QUEUE.md:39`, "#14, #16").
- So the order is 12-13, 14-16, 21-25, 37-39, 41-42, then 57. Row 57 should not be dispatched earlier: it would RAISE on any remaining
  orphan row, which is safe but proves nothing.
- Not while `MIGRATION_FREEZE` is `true` (`RUN-MIGRATION.yml:55-58`).
- Low-traffic window: the file writes nothing, but its counts read three hot tables. Off-peak is the plan's default for
  DB slices (`.kiro/specs/mt-identity-r2/plan.md:237-239`; `.kiro/specs/mt-data-cleanup-r2/plan.md:149` names off-peak for the batched moves of that spec).
- Readers to retire first: none. No code reads anything this lane adds.
- A RAISE means stop and re-plan, never improvise (`MIGRATION-QUEUE.md:75`).

**Window date: left for the owner.**

## 8. Recommendation

Approve rows 57-58 now as a pair, to be dispatched only after the prerequisite rows above are applied and their post-checks passed.
Run `pre-check.sql` first; if it shows anything but `NO` and `0`, stop and report. The approval costs nothing in risk: the
file cannot change data.

## 9. Evidence index

`acceptance.md`, `pre-check.sql`, `post-check.sql`, `rollback-check.sql`, `commands.log`, `outputs/`, `pglite-harness/` (lane evidence);
`owner-packet-outputs/dry-run.mjs`, `owner-packet-outputs/dry-run.txt` (this packet).
