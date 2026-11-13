# VTID-05023 F3: autopilot event loop index predicate (immutable)

## Failure
Local PGlite pass on `20260116000000_vtid_01179_autopilot_event_loop.sql` stopped with
`functions in index predicate must be marked IMMUTABLE`. Reproduced on PGlite with a stub table.

## Original predicate (not edited)
Line 102-104 of `20260116000000_vtid_01179_autopilot_event_loop.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_autopilot_processed_events_recent
    ON public.autopilot_processed_events (processed_at)
    WHERE processed_at > NOW() - INTERVAL '1 hour';
```

The only non-immutable call in any index predicate in that file is `NOW()` here. The other
predicates (`state NOT IN (...)`, `lock_until IS NOT NULL`) are immutable.

## Immutable equivalent: none. The time condition moves into queries.
The intent is a one-hour window for stats. A window that moves with the clock cannot be an
index predicate, so no immutable predicate keeps this meaning. The file's stats functions
already filter with `pe.processed_at > NOW() - INTERVAL '1 hour'` in their query bodies
(lines 240 and 245). `idx_autopilot_processed_events_processed_at` (created by the original
migration) serves that range condition. The fix therefore drops the partial index and creates
no replacement. A plain copy on `processed_at` would duplicate the existing index.

## New migration
- File: `supabase/migrations/20260116000001_vtid_05023_autopilot_recent_index_immutable.sql`
- Content: `DROP INDEX IF EXISTS public.idx_autopilot_processed_events_recent;` plus comments. Re-running is a no-op.
- SHA-256: `5d318c1cc4ad9c08a77c104dcef44950c20d64a1b6338cdd6bf01fa4c1080e14`

## Tests
1. Jest: `services/gateway/test/vtid-05023-fix-immutable-autopilot.test.ts` (static checks on the migration files).
2. PGlite (pgTAP shim, `docs/validation/VTID-05507/pglite-harness/run.mjs`): stub table and indexes
   in `docs/validation/VTID-05023/pgtap/f3_stub.sql`, migration applied twice, assertions in
   `docs/validation/VTID-05023/pgtap/f3_autopilot_recent_index.test.sql`.

### Jest output
```
PASS test/vtid-05023-fix-immutable-autopilot.test.ts
  VTID-05023 F3: autopilot recent index predicate
    ✓ the original migration still holds the non-immutable predicate that causes the failure
    ✓ the fix migration drops the broken index with a guard
    ✓ the fix migration creates no index whose predicate calls a non-immutable function
    ✓ the fix migration contains only the drop statement
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
```

### PGlite output
```
# loaded .../pgtap/f3_stub.sql
# loaded .../20260116000001_vtid_05023_autopilot_recent_index_immutable.sql
# loaded .../20260116000001_vtid_05023_autopilot_recent_index_immutable.sql
1..3
ok 1 - recent index is dropped by the fix migration
ok 2 - processed_at index used by the time-window queries still exists
ok 3 - no partial index with a time predicate remains on autopilot_processed_events
exit=0
```

## Open issue: the chain still fails on a fresh apply
The original file fails at line 102. Sequential migration runners stop at the first failing file,
so `20260116000001` never runs in a fresh apply. Everything in the original file after line 102
(RLS and policy on `autopilot_processed_events`, `autopilot_run_state`, functions) also does not
apply. This fix does not clear that failure. Clearing it needs the owner to choose between
editing the original file (forbidden by the rules here) and splitting the statement out
(a separate decision). Nothing in this MR changes that.

## MR
- Branch: `cutover/vtid-05023-F3-immutable`
- Title: `Draft: VTID-05023 fix autopilot event loop index predicate (immutable)`
- Link: MR_LINK_PENDING
