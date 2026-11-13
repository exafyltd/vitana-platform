# VTID-05023 skip manifest: superseded statements in applied files

Status: DRAFT. Not merged. The apply path does not read this file yet. The owner decides whether
the apply tool uses it (see "Decision needed").

## Why this file exists

Each fix below is a NEW migration placed after its original file. The original file still fails
at its parse or runtime error. On a replay that includes the original, the chain stops there, so
the fix never runs. A replay has to skip the original statement and run the fix instead.

Applied migrations are not edited. This manifest is the record of what a replay skips.

## Entries

| # | Original file (not edited) | Failing point | Replacement migration | Replay action |
|---|---|---|---|---|
| 1 | 20251231000001_vtid_01098_memory_timeline_causality.sql | `window` used as an unquoted column (parse) | 20251231000002_vtid_05023_fix_vtid_01098_window_identifier.sql | skip original, run replacement |
| 2 | 20260117000000_vtid_01183_worker_agent_connector.sql | `NOT` in `CREATE POLICY IF NOT EXISTS` (parse) | 20260117000001_vtid_05023_fix_vtid_01183_policy_syntax.sql | skip original, run replacement |
| 3 | 20260205000000_fix_oasis_events_disk_io_indexes.sql | inner `$$` closes the `DO $$` block early (parse) | 20260205000001_vtid_05023_fix_oasis_events_disk_io_indexes.sql | skip original, run replacement |
| 4 | 20260420130000_BOOTSTRAP_ai_usage_log.sql | inner `$$` closes the `do $$` block early (parse) | 20260420130001_vtid_05023_fix_ai_usage_log_dollar_quote.sql | skip original, run replacement |
| 5 | 20260524000000_VTID_03036_bootstrap_cache.sql | `\|\|` inside `COMMENT ON TABLE` (parse) | 20260524000001_vtid_05023_fix_bootstrap_cache_comment.sql | skip original, run replacement |
| 6 | 20260116000000_vtid_01179_autopilot_event_loop.sql | index predicate with `NOW()` at line 102 (not immutable) | 20260116000001_vtid_05023_autopilot_recent_index_immutable.sql | skip the line-102 statement only; the plain index at line 98 on processed_at already covers lookups |

Files 1 to 5 are parse errors, so each replay must skip the whole original file. File 6 fails on
one statement, so only that statement is skipped.

## Not in this manifest

- The seven BOOTSTRAP files with `\set ON_ERROR_STOP on` (MR !34, merged). The apply path now blanks
  `\set` and `\echo` lines. No file is skipped for them.
- 20251231000001_vtid_01088_matchmaking_engine.sql: owner decision (option c). The file stays failing
  on a fresh database. Recorded in the owner-decision file, not here.

## Decision needed (owner)

Choose how the apply path uses this manifest:
1. The apply path reads this file and skips the listed originals, recording each skip in its log.
2. The skip is done by hand for each replay, with the same list written into the run's log.

Either way, production is not touched by this MR. Production replay is an owner command.

## Verification

Each replacement has a test in its own MR (see the F1 and F3 records). No replacement is merged
in this MR.
