# VTID-05023 F1 (syntax group): fix record

Scope: 12 migrations that failed PGlite parsing on main. Five get a new fix migration, each on its
own branch with a draft MR. Seven contain only a psql meta-command and get no change (see below).
No migration under `supabase/migrations/` was edited. Nothing was merged. No production, AWS or
remote database was touched. No writes as account `a27552a3`.

## Results

| # | Failing file | Error at parse | Action | New migration | SHA-256 (new file) | Branch, commit | MR | Test result |
|---|---|---|---|---|---|---|---|---|
| 1 | 20251231000001_vtid_01098_memory_timeline_causality.sql | `window` (reserved word as column) | Fix | 20251231000002_vtid_05023_fix_vtid_01098_window_identifier.sql | 05a5807e52dd8d215fbb5933a5c208896948dfd898bacbf6550bcf12827ebc9c | cutover/vtid-05023-F1-memory-timeline-window, a25f0b9d9a | !36 | jest 4 passed, 0 failed; PGlite applies over shim |
| 2 | 20260117000000_vtid_01183_worker_agent_connector.sql | `NOT` in `CREATE POLICY IF NOT EXISTS` | Fix | 20260117000001_vtid_05023_fix_vtid_01183_policy_syntax.sql | fb53e92efd6c89ecaebde6b2a78ed397ab1feb3878d7fce9e35175b4958ef5ab | cutover/vtid-05023-F1-worker-connector-policy, e58f16cba2 | !37 | jest 3 passed, 0 failed; PGlite applies over shim and 20251217000000 |
| 3 | 20260205000000_fix_oasis_events_disk_io_indexes.sql | `SELECT` (inner `$$` closed the `DO $$` block) | Fix | 20260205000001_vtid_05023_fix_oasis_events_disk_io_indexes.sql | 01420d8712732ded417bebaddfee932c689e8eacc4994610ec0a6d7533136041 | cutover/vtid-05023-F1-oasis-indexes-dollar-quote, 0c676e023c | !38 | jest 3 passed, 0 failed; parse passes. Open: CONCURRENTLY (see below) |
| 4 | 20260420130000_BOOTSTRAP_ai_usage_log.sql | `refresh` (inner `$$` closed the `do $$` block) | Fix | 20260420130001_vtid_05023_fix_ai_usage_log_dollar_quote.sql | 0a79492656f59a01762478b9e5ee670a9d4050760791c8120b8ae199fb48feff | cutover/vtid-05023-F1-ai-usage-log-dollar-quote, af65d4c55e | !39 | jest 4 passed, 0 failed; PGlite applies over shim |
| 12 | 20260524000000_VTID_03036_bootstrap_cache.sql | `||` in `COMMENT ON TABLE` | Fix | 20260524000001_vtid_05023_fix_bootstrap_cache_comment.sql | 4e0f4c28aa4e0d8ffeac2a6701bcc11138796ba1c6278837bf01e3ee9842f3da | cutover/vtid-05023-F1-bootstrap-cache-comment, 5223e542e2 | !40 | jest 3 passed, 0 failed; PGlite applies |
| 5 | 20260420170000_BOOTSTRAP_seed_ai_policies_fixed.sql | `\set` (psql meta-command) | No change | none | none | none | none | psql meta-command only: `\set ON_ERROR_STOP on`, handled by an apply-path strip, separate task |
| 6 | 20260421220000_BOOTSTRAP_admin_kpi_surface.sql | `\set` | No change | none | none | none | none | psql meta-command only: `\set ON_ERROR_STOP on`, handled by an apply-path strip, separate task |
| 7 | 20260421230000_BOOTSTRAP_admin_kpi_retention_fix.sql | `\set` | No change | none | none | none | none | psql meta-command only: `\set ON_ERROR_STOP on`, handled by an apply-path strip, separate task |
| 8 | 20260421250000_BOOTSTRAP_admin_insights.sql | `\set` | No change | none | none | none | none | psql meta-command only: `\set ON_ERROR_STOP on`, handled by an apply-path strip, separate task |
| 9 | 20260430120000_BOOTSTRAP_pause_dev_autopilot_auto_approve.sql | `\set` | No change | none | none | none | none | psql meta-command only: `\set ON_ERROR_STOP on`, handled by an apply-path strip, separate task |
| 10 | 20260501000000_VTID_02639_autopilot_finding_completed_state.sql | `\set` | No change | none | none | none | none | psql meta-command only: `\set ON_ERROR_STOP on`, handled by an apply-path strip, separate task |
| 11 | 20260501010000_VTID_02640_dev_autopilot_get_table_schema.sql | `\set` | No change | none | none | none | none | psql meta-command only: `\set ON_ERROR_STOP on`, handled by an apply-path strip, separate task |

## Method

- Each fix copies the failing file to a new name with a later timestamp, then changes only the
  broken statement. A parse error rejects the whole file before any statement runs, so the copy
  carries the rest of the file's intended effect. The original stays unedited.
- The new migration is placed right after the file it fixes. Its dependencies (for example
  `vtid_ledger`, the memory tables, `ai_usage_log`, `oasis_events`) come from earlier timestamps.
- Each test reads the original and the fix from the repo. It checks the effect of the change, and
  that the fix equals the original except for that change. Run with `npx jest <file>` in
  `services/gateway`.
- PGlite (`/projects/sandbox/.tools/pglite`) ran each original and each fix. The original fails with
  code 42601 at the reported token. The fix parses. Its later errors (missing roles or tables) come
  from the minimal shim, not from the migration.
- `services/gateway/node_modules` was linked to an existing install for the jest runs. The link is
  git-ignored and is not committed.

## Open items

- Item 3 (oasis) keeps four `CREATE INDEX CONCURRENTLY` statements. A multi-statement batch runs in one
  transaction, so PostgreSQL rejects them with 25001 there. The concurrent-index task owns this. It is a
  runtime issue and does not affect the parse fix. Item 4 only has a `REFRESH ... CONCURRENTLY` inside a
  cron command string, which runs later and is not affected.
- Items 5 to 11: the only psql line is `\set ON_ERROR_STOP on`. Per the owner decision, these
  files get no change here. The strip of `\set` and `\echo` lines is a separate apply-path task.
- Item 1's original text stays in the repo unedited. Any full replay that includes the original
  still hits the parse error. Replays must skip the original and run the fix.
