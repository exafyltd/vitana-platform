# VTID-04494: one current fact per key

Found during the staging verification of the memory work (2026-09-24): the
test account's Memory Garden listed two current `preferred_language` facts.
Live count: 70 key groups across 26 users had more than one current row in
`memory_facts`, 19 of them with conflicting values.

## Root cause

`write_fact()` (last changed by VTID-04341):

1. `SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED`: a concurrent writer skipped
   the locked row, saw no current fact and inserted a second one. Two writers
   on a key with no current row had nothing to lock at all.
2. It superseded `WHERE id = v_old_fact_id`, one row only, so an existing
   duplicate survived every later write.

## Acceptance criteria

AC-1: concurrent writes to one key leave exactly one current row, with or without an existing row (SQL shape test, plus the real Postgres 16 race run in commands.log).
TEST: services/gateway/test/vtid-04494-write-fact-one-current-fact.test.ts

AC-2: a write supersedes every other current row for its key.
TEST: services/gateway/test/vtid-04494-write-fact-one-current-fact.test.ts

AC-3: the VTID-04341 same-value skip and provenance ranking are unchanged.
TEST: services/gateway/test/vtid-04494-write-fact-one-current-fact.test.ts

AC-4: existing duplicates are repaired, newest wins, nothing deleted.
TEST: services/gateway/test/vtid-04494-write-fact-one-current-fact.test.ts

AC-5: applied live: 0 duplicate groups, 918 -> 838 current rows (80 superseded), grants unchanged. See commands.log.
TEST: services/gateway/test/vtid-04494-write-fact-one-current-fact.test.ts (live SQL evidence in docs/validation/VTID-04494/commands.log)
