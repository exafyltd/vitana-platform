# VTID-03820 — DeepSeek-powered execution on-ramp

## Report

Part 3 of the VTID-03818..03823 plan. Per explicit platform-owner direction
("it should be wired to the DeepSeek API for the vibe coding part"), this
VTID gives the Operator Console a way to actually execute an
already-approved VTID — writing code, opening a real PR — with that
specific invocation forced onto DeepSeek (`deepseek-flash`), WITHOUT
changing the `llm_routing_policy` stage the autonomous self-healing
pipeline uses for its own executions.

Reuses the existing, heavily-guarded Dev Autopilot execution machinery
(`approveAutoExecute()`'s full safety gate: kill_switch, allow/deny scope,
budget, concurrency, tests_missing, PR-flood guard) rather than building a
parallel path. Adds exactly two new governance gates the reused machinery
doesn't have (it was built for scanner-originated findings, not
operator-originated ones): a dedicated kill switch (default OFF) and a
`spec_status='approved'` check on the target VTID.

## Acceptance Criteria

AC-1 — `callViaRouter()` accepts an optional per-call
`providerOverride`/`modelOverride` that replaces the stage's PRIMARY only;
the stage's own policy-configured FALLBACK still applies on override
failure. Every existing caller (which omits both fields) is byte-for-byte
unaffected.

TEST: `test/vtid-03820-llm-router-override.test.ts` — override-used,
no-override-unaffected, lone-field-ignored, and fallback-still-applies
cases, all against the real `callViaRouter()` with a mocked network layer
(same harness as the pre-existing `llm-router.test.ts`).

AC-2 — An execution queued with `metadata.llm_on_ramp_override` set ALWAYS
routes through the direct `callMessagesApi`/`callViaRouter` path, bypassing
the worker-queue path entirely (which dispatches to a hardcoded
Claude-subscription model unrelated to `llm_routing_policy` and could never
honor an override). An execution with no such metadata — every existing
self-healing execution — is completely unaffected.

TEST: `test/vtid-03820-execution-onramp-metadata.test.ts` —
`extractLlmOnRampOverride()` is a pure, directly-unit-tested function
(permissive about malformed jsonb, never throws); a source-check pins the
worker-queue-skip branch condition and the override being passed into
`callMessagesApi` (the same established pattern this repo uses for
Supabase-dependent functions that aren't unit-testable in isolation, e.g.
`vtid-03818-reaper-terminal-flag.test.ts`).

AC-3 — `triggerOperatorExecution()` refuses to run unless
`OPERATOR_EXECUTION_ONRAMP_ENABLED === 'true'` (default OFF; any other
value, including a near-miss like `'yes'`, stays disabled).

TEST: `test/vtid-03820-operator-execution-onramp.test.ts` — "rejects when
the kill switch is not 'true'" + "rejects an arbitrary non-'true' value".

AC-4 — `triggerOperatorExecution()` refuses to run unless the target VTID
exists, is not terminal, and has `spec_status='approved'` — checked BEFORE
any recommendation/plan row is written.

TEST: `test/vtid-03820-operator-execution-onramp.test.ts` — the
not-found/terminal/not-approved cases, each asserting zero `fetch` calls
happened (nothing written before the gate passes).

AC-5 — On success: an `autopilot_recommendations` row (`source_type:
'operator_onramp'`, newly allowlisted) and a `dev_autopilot_plan_versions`
row are created from the caller-supplied plan; `approveAutoExecute()` (the
FULL existing safety gate, unmodified) is called and must itself succeed;
the resulting execution row is PATCHed in ONE call that both stamps
`metadata.llm_on_ramp_override` and fast-forwards `execute_after` to now —
avoiding any window where a background tick could pick up the execution
before the override is attached.

TEST: `test/vtid-03820-operator-execution-onramp.test.ts` — "creates the
recommendation + plan rows... on success" asserts the recommendation body,
the `approveAutoExecute` call args, and the combined PATCH body shape.

AC-6 — A safety-gate rejection from `approveAutoExecute()` (e.g.
`tests_missing`) is surfaced back to the caller with its violations, and no
execution metadata is ever stamped (there is no execution row to stamp).

TEST: `test/vtid-03820-operator-execution-onramp.test.ts` — "surfaces a
safety-gate rejection... without stamping anything".

AC-7 — `operator_onramp` is registered in
`EXECUTABLE_RECOMMENDATION_SOURCE_TYPES` per that file's own documented
process, and the existing scope-lock test is updated deliberately (not
loosened silently) to include it.

TEST: `test/autopilot-executable-source-types.test.ts` (updated) — new
"accepts operator_onramp" case + the five-entry canonical-list lock,
`test/autopilot-source-type-filter-call-sites.test.ts` (unmodified, still
passes — its assertions are dynamic against
`executableSourceTypesPostgrestIn()`, not a hardcoded list).

AC-8 — A new `autopilot_execute_task` Operator Console tool is registered
(gemini-operator.ts + tool-registry.ts) as a thin, governance-logged
wrapper around `triggerOperatorExecution()`.

TEST: manual code read (see commands.log); no dedicated unit test, matching
this codebase's existing coverage norm for `gemini-operator.ts`'s tool
handlers (grepped: neither `executeCreateTask` nor `evaluateGovernance` has
one either) — the underlying capability this wrapper calls is fully
covered by AC-3..AC-6 above, and the wrapper itself is inert until the
kill switch is turned on.

AC-9 — `tsc --noEmit` clean; no regression in the full gateway suite.

TEST: `outputs/tsc-noemit.txt`; `outputs/jest-vtid-03820-filter.txt` (5/5
suites, 42/42 tests); `outputs/jest-full-suite.txt` (748/749 suites — 1
pre-existing skip — 13,753/13,788 tests passing, 0 failures).

## OASIS Impact

OASIS_PROOF: On a successful on-ramp trigger, `triggerOperatorExecution()`
(`services/gateway/src/services/operator-execution-onramp.ts`, end of the
function) calls `emitOasisEvent({ type: 'operator.execution_onramp.triggered',
vtid: input.vtid, source: 'operator-execution-onramp', status: 'success',
payload: { execution_id, finding_id, vtid, requested_by, provider: 'deepseek',
model: 'deepseek-flash', correlation_id } })`. The new
`autopilot_execute_task` tool handler (`executeExecuteTask()` in
`gemini-operator.ts`) also emits a `governance.evaluate` OASIS event before
calling the on-ramp, mirroring `autopilot_create_task`'s existing pattern —
both a rejection and a real trigger are always OASIS-visible, never silent.

## Deliberately NOT attempted

- **No live invocation of the on-ramp against the real repo.** The kill
  switch is unset everywhere, so the capability is inert by construction —
  exercising it for real would mean actually opening a PR against this
  org's live repository, exactly the blast radius the default-OFF gate
  exists to prevent until the platform owner deliberately enables it.
- **Auto-deriving plan content / files_referenced from a diagnosis.** The
  self-healing path's `deriveTestPathsForPlan` machinery is diagnosis-driven
  and doesn't apply to an operator's freeform "execute this VTID" request.
  The caller supplies the plan explicitly; the existing `tests_missing`
  safety-gate rule still runs unchanged on whatever is supplied.
- **A Command Hub UI element for this.** Out of scope for VTID-03820 (that
  is VTID-03822, "Operator chat cockpit UI", which was explicitly NOT
  selected in the approved 03818→03819→03820→03821 chain). The capability
  is reachable today only via the Operator Console chat's
  `autopilot_execute_task` tool call.
- **Extending the DeepSeek override to `runWorkerTask`'s worker-queue
  path.** That path dispatches to a separate `worker-runner` service with
  its own hardcoded model config, unrelated to `llm_routing_policy` — an
  execution carrying the on-ramp's override simply skips that path
  entirely rather than trying to make it DeepSeek-aware, which would be a
  much larger, separate change to a different service.
- **A dedicated unit test for `executeExecuteTask`/`evaluateGovernance` in
  gemini-operator.ts.** Consistent with this file's existing (lack of)
  coverage for its sibling tool handlers — the governance-relevant logic
  it delegates to is fully covered instead.
