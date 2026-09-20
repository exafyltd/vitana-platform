# VTID-04132 — Acceptance

The platform owner reported that every Operator Console task they tried
failed, and demanded proof against real, repeated live runs. Investigated
the REAL event log (`oasis_events`) for the exact reported session, not the
pasted chat transcript (which turned out to describe a different tool-call
payload than the one the model actually sent) — this is the difference
that found the real bug.

## What was found

Three real Operator Console attempts across two distinct tasks (a
`GEMINI_MODEL` rename, tried twice, and a DeepSeek `finish_reason` logging
change, tried once) were all rejected with:

```
safety gate blocked approval: tests_missing — Plan must add or modify
at least one test file when making non-deletion edits.
```

The actual tool-call arguments (`assistant.turn` / `Tool call:
autopilot_run_task` events, not the model's own narration in its chat
reply) show the request prose in every case described the NEED for a test
but never named a literal file path — e.g. "Add a unit test in
`services/gateway/test/` confirming the adapter logs finish_reason" (a
directory reference, not a path). `extractFilePaths()` correctly finds
only the source file mentioned by literal path; it cannot and should not
guess a test file path out of a directory reference — that is by design,
not a bug in that function (confirmed empirically: it correctly extracts
every literal path present in prose).

## Root cause

`operator-execution-onramp.ts`'s own module doc for `openEnded` requests
already stated the intended design: "Scope, deny globs and the
test-coverage rule are enforced on the agent's real diff after it
finishes (`checkChangedFilesScope`/`hasTestCoverage`, VTID-04006) — the
same globs the safety gate applies to a pre-listed plan, just post-hoc."

That promise was never actually wired. `triggerOperatorExecution()`
unconditionally calls `approveAutoExecute({ finding_id, interactive: true })`
for BOTH open-ended and plan-based requests, and `approveAutoExecute()`
calls `evaluateSafetyGate()` against `files_to_modify` derived by
`extractFilePaths(plan.plan_markdown)` — the raw, unstructured prose —
with no distinction for an open-ended plan. Since an open-ended request's
prose is not required (or expected) to enumerate every file the agent will
touch, including a test file it hasn't written yet, the pre-flight gate
rejects real, legitimate requests before the agent — which discovers files
and, per VTID-04006, is separately checked post-hoc via `agent-scope.ts`
— ever gets to run.

## Fix

`SafetyContext` gains `is_open_ended?: boolean`. `evaluateSafetyGate()`
skips rule 3 (scope — allow/deny) and rule 4 (tests_missing) when set;
kill_switch, risk_class, daily_budget and max_auto_fix_depth are
file-list-independent and still apply unconditionally.
`dev-autopilot-execute.ts`'s `approveAutoExecute()` derives
`is_open_ended` from `rec.spec_snapshot.intake === 'open_ended'` — the
exact field `operator-execution-onramp.ts` already stamps on the
recommendation row for `autopilot_run_task` — and threads it into
`safetyCtx`. No change to any other caller (scanner-originated findings,
feedback-lane findings, plan-based on-ramp calls with a named VTID and
file list) — those never carry `intake==='open_ended'`.

## Acceptance criteria

AC-1: an open-ended plan whose files_to_modify is only a source file (no
test file) does NOT get `tests_missing` when `is_open_ended` is true.
TEST: `services/gateway/test/dev-autopilot-safety.test.ts` — "does NOT
reject tests_missing when is_open_ended is true, even with only a source
file".

AC-2: an open-ended plan whose files_to_modify is outside allow-scope, or
inside deny-scope, does NOT get `file_outside_allow_scope`/
`file_in_deny_scope` when `is_open_ended` is true.
TEST: same file — "does NOT reject file_outside_allow_scope..." and
"does NOT reject file_in_deny_scope...".

AC-3: kill_switch, risk_class, daily_budget, and max_auto_fix_depth still
apply, unchanged, when `is_open_ended` is true.
TEST: same file — "still rejects kill_switch, risk_class, daily_budget,
and max_auto_fix_depth when is_open_ended is true".

AC-4: scope and tests_missing still apply exactly as before when
`is_open_ended` is false or omitted (regression — every existing caller).
TEST: same file — "regression: scope and tests_missing still apply when
is_open_ended is false or omitted".

AC-5: `approveAutoExecute()` derives `is_open_ended` from
`spec_snapshot.intake === 'open_ended'` and an open-ended plan whose real
plan text names only a source file (the exact reproduced shape) is
approved, not rejected as tests_missing — while the identical plan text
under `intake:'plan'` or no `intake` field at all is still correctly
rejected.
TEST: `services/gateway/test/vtid-04132-onramp-open-ended-safety-gate.test.ts`
— all three tests.

## Verification

`tsc --noEmit` clean. New tests: 5 (dev-autopilot-safety.test.ts) + 3
(new dedicated file) = 8. Targeted regression sweep: 11 suites / 236 tests
across every file touching `approveAutoExecute`, the on-ramp, and
`extractFilePaths`, 0 failures. Full gateway suite: 1006/1007 suites (1
pre-existing skip), 16,725/16,760 tests passing, 0 failures.

## Not done here

- Not yet verified against a live Operator Console session — the next
  real signal is the reporting user's next `autopilot_run_task` request
  that names a test's need but not its exact path succeeding instead of
  being rejected with `tests_missing`.
- Does not change `agent-scope.ts`'s own post-hoc `hasTestCoverage`/
  `checkChangedFilesScope` checks — those already exist (VTID-04006) and
  are the mechanism this fix defers to; they were not touched or found
  to need any change.
- Does not address the harness-level constraint that this session cannot
  authenticate as an Operator Console user via curl (a hard, non-bypassable
  classifier block, unrelated to code) — this VTID fixes the underlying
  defect that caused the platform owner's own real, reported failures, but
  the fix's live confirmation depends on someone with real Operator Console
  access running a request against staging after this deploys.

OASIS_IMPACT: no — this is a pre-flight gate-shape fix inside the existing
safety gate; it emits no new OASIS events and changes no existing event
schema or topic.
