# VTID-03844 — `dev_autopilot_outcomes` records operator on-ramp findings

## Report

`recordOutcome()` (`services/gateway/src/services/dev-autopilot-outcomes.ts`)
early-returned for any finding whose `source_type` was not `dev_autopilot` or
`dev_autopilot_impact`. That pair is a hard-coded copy of the original
allowlist that predates two later changes: VTID-02984 made
`autopilot-executable-source-types.ts` the single list of source types that
may enter the executor lane, and VTID-03820 added `operator_onramp` to it.
Neither reached this file. Observed on staging 2026-09-13: the VTID-03829
on-ramp finding was approved (`decision: approved` via `approveAutoExecute`)
and executed twice, and `dev_autopilot_outcomes` received zero rows for it
(recorded in `docs/validation/VTID-03841/acceptance.md`, finding 5).

The table itself carried the same stale pair as a CHECK constraint
(`dev_autopilot_outcomes_source_type_check`, confirmed live via
`pg_constraint` on 2026-09-13), so the code change on its own would have
turned a silent skip into a swallowed 400 on every on-ramp INSERT. The fix
is therefore two halves:

1. Code — `recordOutcome()` gates on `isExecutableSourceType()` (the
   executor's own allowlist) instead of the hard-coded pair;
   `FindingShape.source_type` is widened to `string | null`. Non-executable
   source types (user-facing recommendations) still skip. Nothing else in
   the file changes; `recordExecOutcome()` never filtered on source_type.
2. Schema — migration
   `supabase/migrations/20260913100000_vtid_03844_outcomes_source_type_allowlist.sql`
   drops and re-adds the CHECK with the full allowlist. A test reads the
   migration file and fails if its list ever drifts from
   `EXECUTABLE_RECOMMENDATION_SOURCE_TYPES`.

The migration is a file in this PR, not applied by this session. Until it is
applied (`RUN-MIGRATION.yml` with this file path), an on-ramp outcome INSERT
is rejected by the constraint and logged as
`[dev-autopilot-outcomes] insert failed (400)` — loud, not silent, and no
worse than today's zero rows.

## Acceptance Criteria

AC-1 — An `operator_onramp` finding produces an outcome INSERT carrying the
finding's `source_type`, scores and the decision.

TEST: `test/vtid-03844-outcomes-record-operator-onramp.test.ts` — "records an
outcome row for an operator_onramp finding (the case observed missing on
staging)".

AC-2 — The two legacy source types still record exactly as before.

TEST: same file — "still records the legacy dev_autopilot source_type" and
"... dev_autopilot_impact ...".

AC-3 — A non-executable source type still skips; no INSERT is attempted.

TEST: same file — "still skips a non-executable source_type — no INSERT is
attempted".

AC-4 — Null source_type and a missing finding skip.

TEST: same file — "skips a null source_type and a missing finding".

AC-5 — The migration's CHECK list equals `EXECUTABLE_RECOMMENDATION_SOURCE_TYPES`
(drift guard, both directions).

TEST: same file — "migration 20260913100000 lists exactly
EXECUTABLE_RECOMMENDATION_SOURCE_TYPES".

AC-6 — No regression: `tsc --noEmit` clean; scoped suites green; full gateway
suite green.

TEST: `outputs/tsc-noemit.txt` (exit 0); `outputs/jest-scoped-outcomes.txt`
(3 suites, 26 tests); `outputs/jest-full-suite-tail.txt`.

## Not verified here

The migration has not been applied to the live database by this session
(schema changes ship as reviewed files; applying is a separate
`RUN-MIGRATION.yml` dispatch after merge). The live constraint was read,
not changed. The first real signal after both halves are live is a
`dev_autopilot_outcomes` row with `source_type = 'operator_onramp'` on the
next on-ramp execution on staging.
