# VTID-03818 — Ledger hygiene: title-backfill gap, reaper terminal flag, status drift

## Report

Part 1 of a 6-VTID plan (VTID-03818..03823) to turn the Command Hub Tasks
board and Operator chat into a real "vibe coding" orchestrator. This VTID is
the prerequisite cleanup: three concrete, independently-confirmed code bugs
that produced the mess reported live on the board (ghost-titled cards,
non-terminal deleted rows, a status value the frontend didn't recognize).

All three were found by direct DB query + source read, not assumption:
1,682 total `vtid_ledger` rows; 703 still carrying the literal placeholder
title `"Allocated - Pending Title"` (184 of them non-terminal); 47 rows on
`status='complete'` (a second, unrecognized spelling of "done"); 204+ rows
`status='deleted'` with `is_terminal` not true.

## Acceptance Criteria

AC-1 — A VTID allocated via `/api/v1/vtid/allocate` or `/allocate-internal`
with no explicit `source` gets a real, non-placeholder title within the
same request — never a silent `null`/no-op backfill.

TEST: `test/vtid-03818-allocation-title.test.ts` — `deriveAllocationTitle()`
now always returns a truthy string for every input shape, including the
exact bug-triggering case (`source='api'`, the default). Both `/allocate`
and `/allocate-internal` call sites updated; `/allocate-internal` previously
had no title logic at all.

AC-2 — New reaper-tombstoned rows have `is_terminal=true`, matching the
Command Hub's own manual-delete endpoint.

TEST: `test/vtid-03818-reaper-terminal-flag.test.ts` — source-level regression
guard on `allocatedOrphanReaperTick()`'s PATCH body (the function needs a
live Supabase connection and isn't unit-testable in isolation, consistent
with this test file's own stated scope for other Supabase-dependent helpers
in the same module).

AC-3 — No live `vtid_ledger` row has `status='complete'` after the one-time
migration; both old and new rows of either spelling render correctly on the
board.

TEST: `outputs/live-verification.txt` (before: 47 rows; after: 0 rows, live
query) + `test/vtid-03818-complete-completed-drift.test.ts` (frontend
defense-in-depth: `mapStatusToColumn()`, and the task drawer's
`isFinalMode`/`isInconsistentState`/`isCompleted` checks, all now recognize
`'complete'` alongside `'completed'`, so a future stray row of either
spelling still renders/behaves correctly).

AC-4 — Evidence records the before/after row counts for the stale/ghost/drift
rows this VTID targets.

TEST: `outputs/live-verification.txt`.

AC-5 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-6 — No regression: the new VTID-03818 test files and the full gateway
suite both pass.

TEST: `outputs/jest-vtid-03818-filter.txt` (3/3 new suites, 16/16 tests) and
`outputs/jest-full-suite.txt` (740/741 suites — the +3 vs. the prior VTID's
737/738 baseline are exactly these new files — 1 pre-existing skip,
13,689/13,724 tests passing, 0 failures).

## Deliberately NOT attempted

- **Backfilling real titles onto the 703 already-placeholder-titled rows.**
  There is no signal left to derive a meaningful title from for most of
  them (many predate the `source` field being populated consistently) —
  guessing one would be inventing data. The code fix stops any *new* row
  from ever landing on the placeholder again; existing rows are addressed
  instead by VTID-03823's planned bulk-archive/filter UI, where a human can
  actually look at each one.
- **Running `backlog-cleanup-apply.ts --execute` against the live >30-day
  stale backlog.** That script already exists and is dry-run by default —
  archiving real backlog rows is a judgment call on content, not a bug fix,
  and belongs to VTID-03823 (or a deliberate follow-up) after a human
  reviews its dry-run report, not folded silently into this VTID.
- **A `metadata.source` enum/allowlist.** Mentioned as a stretch scope item
  when this VTID was planned, but it's not covered by any of the acceptance
  criteria above and touches every write site in the repo — real scope
  creep for a ledger-hygiene bug-fix VTID. Flagging it here so it isn't
  lost, not silently dropping it.
