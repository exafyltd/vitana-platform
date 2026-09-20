# VTID-04201 — Acceptance

The Operator Console's `autopilot_run_task` tool (`services/gateway/src/services/tool-registry.ts`)
accepts an optional `title` argument, described as "Optional short ledger
title; derived from the request when omitted." Before this change the
handler (`executeRunTask()`, `services/gateway/src/services/gemini-operator.ts`)
passed `args.title.trim()` straight into `triggerOperatorExecution()` with
no upper bound of its own — an arbitrarily long caller-supplied string
would flow, unbounded at this layer, into
`deriveVtidTitleFromPlan()`/`allocateAndRegisterVtid()`
(`operator-execution-onramp.ts`) before any cap was applied there.

## What was found

`deriveVtidTitleFromPlan()` already truncates its final candidate to 140
characters (`.slice(0, 140)`), so the ledger row itself was never at risk
of an unbounded title reaching Postgres. But that truncation happens two
call frames downstream of the tool boundary, with no cap and no log line
at the point where the caller-controlled value is actually accepted — the
same "cap it at the boundary, not two frames downstream" pattern this
repo's own VTID-04196 (operator chat message length) and VTID-03836-era
tool argument bounds already establish elsewhere in this file
(`TURN_EVENT_ARGS_MAX_CHARS`, `clipForTurnEvent`).

## Fix

New `capOperatorRunTaskTitle()` (exported, pure) and
`OPERATOR_RUN_TASK_TITLE_MAX_CHARS = 200` in `gemini-operator.ts`, applied
at `executeRunTask()`'s existing title-handling call site — a soft cap
(truncate, not refuse, since this is only a display string, unlike
`autopilot_run_task`'s hard-refusal `request` length guard which would be
a separate task): a title over 200 characters is truncated to exactly 200
and the truncation is logged once (`console.info`) at the point it occurs;
a title at or under 200 characters (after trimming) passes through
unchanged, matching the pre-existing `.trim()` behavior; an omitted,
empty, or whitespace-only title resolves to `undefined`, matching the
pre-existing behavior exactly.

## Acceptance criteria

AC-1: a `title` over 200 characters is truncated to exactly 200 characters
before being passed to `triggerOperatorExecution()`.
TEST: `services/gateway/test/vtid-04201-operator-run-task-title-cap.test.ts`
— "truncates a title over the cap to exactly the cap length".

AC-2: a `title` at or under 200 characters is passed through unchanged
(after the pre-existing `.trim()`).
TEST: same file — "passes a title at exactly the cap through unchanged"
and "passes a title under the cap through unchanged (after trimming)".

AC-3: the truncation is logged once, at info level, only when truncation
actually occurs.
TEST: same file — "logs once at info level when truncation occurs" and
"does NOT log when no truncation occurs".

AC-4 (regression): an omitted, empty, or whitespace-only title still
resolves to `undefined`, exactly as the pre-existing inline check did.
TEST: same file — "returns undefined for an omitted, empty, or
whitespace-only title" and "returns undefined for a non-string value
passed at the type boundary".

## Verification

`tsc --noEmit` clean. New tests: 7, all against the real, unmocked
`capOperatorRunTaskTitle()` function (not a mock of it).

Regression sweep — every test file this session could find that exercises
`executeRunTask`/`autopilot_run_task`: `operator-simulated-tool-call-detector.test.ts`,
`vtid-04007-open-ended-intake.test.ts`,
`vtid-04018-operator-bootstrap-pack.test.ts`,
`vtid-04022-operator-threads.test.ts`,
`vtid-04033-operator-execution-follow.test.ts`,
`vtid-04132-onramp-open-ended-safety-gate.test.ts`,
`vtid-04172-operator-simulated-tool-call-retry.test.ts`,
plus the new file — 8 suites, 78 tests, 0 failures.

## Not done here

- `deriveVtidTitleFromPlan()`'s own 140-char slice is untouched — it stays
  the final, authoritative cap on what actually lands in `vtid_ledger`,
  and 140 < 200 means it always binds at least as tightly as this new
  boundary cap. This VTID adds an earlier, logged cap at the tool-argument
  boundary; it does not change what value ultimately gets stored.
- Not verified against a live Operator Console session — this tool is
  gated behind `OPERATOR_EXECUTION_ONRAMP_ENABLED` and
  `OPERATOR_VTID_SELF_ALLOCATE_ENABLED`, both default-off, and this
  session has no live Operator Console access; the next real signal is a
  real `autopilot_run_task` call with an over-length `title` on staging
  logging the truncation line.

OASIS_IMPACT: no — this is an input-shaping change inside an existing tool
handler; it emits no new OASIS events and changes no existing event schema
or topic.
