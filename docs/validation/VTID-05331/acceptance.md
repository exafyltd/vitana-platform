# VTID-05331 — Collab handoff accepts sequential sessions of the lane's own seat

Plan `collab-multi-builder-handoff` (Change, rules 1–2a–e), lane `sequential-builders`. Test file
`scripts/collab/queue.test.mjs`, cases "VTID-05331 1"–"8".

AC-1: two sessions of the lane's seat, one after another, both logged, `claimed_by` = the last → Collab handoff and
Lane scope pass.
TEST: VTID-05331 1.
AC-2: interleaved builders (A, B, A) fail with "builder sessions overlap".
TEST: VTID-05331 2.
AC-3: a session of another seat fails ("not a session of the lane's seat"), and scope-check still refuses its lane-file
commit.
TEST: VTID-05331 3.
AC-4: a session of `reviewer_seat`, a reviewer-agent session, or a session that wrote a review entry on the lane cannot
build it ("reviews this lane and cannot also build it").
TEST: VTID-05331 4 (a)(b)(c).
AC-5: sequential builders do not widen the lane paths: a file outside `paths` still fails scope-check.
TEST: VTID-05331 5.
AC-6: a single-builder lane is unchanged, including the `claimed_by` check.
TEST: VTID-05331 6.
AC-7: a builder session not named in the lane's `## Log` fails.
TEST: VTID-05331 7.
AC-8: `claimed_by` naming an earlier builder after a takeover fails.
TEST: VTID-05331 8.
AC-9: no regressions: `node --test scripts/collab/*.test.mjs` 154 tests, 0 failures (main: 146, 0 failures; the same
1 test skipped in both). 
TEST: node --test scripts/collab/*.test.mjs — evidence `outputs/collab-suite-green.txt`, `outputs/red-on-main.txt` (7 of 8 red on main).
AC-10: unchanged by design: claims, scope-check, paths, permissions (`PERM`), reviewer rules, `_plan` lanes and lanes
without a `seat` keep the one-session rule; nothing special-cased by slug, lane or PR.
TEST: VTID-05331 5 and 6, and the unchanged existing collab suites (154 tests, 0 failures).
