# VTID-04254 — activation-order bug in approveAutoExecute + standing Autonomous Defect-Fix Authority rule

## What happened

While building a clean real-world test case for the LLM-review/validator
tool set (separate work, this session), the Command Hub "Activate" button
and the Operator Console's `autopilot_activate_recommendation` tool were
both exercised live against finding `9e1bdb97-d4ec-449d-a00b-5ec70428cada`
("CVE: package.json"). Both failed identically, verbatim:

```
Activation succeeded but starting the execution failed: finding status is
'activated' — only 'new' findings can be approved.
```

The finding itself allocated a real VTID (VTID-04250) and moved to
`status='activated'` — the activation half worked — but no execution was
ever created, stranding the finding permanently (every subsequent Activate
click reported "Already activated" and never retried).

## Root cause

`bridgeActivationToExecution()` in
`services/gateway/src/services/dev-autopilot-execute.ts` is the ONE shared
bridge both human-facing activation paths call:

- `routes/autopilot-recommendations.ts`'s `POST /:id/activate` (Command Hub)
- `services/operator-recommendation-tools.ts`'s `executeActivateRecommendation()`
  (Operator Console chat tool)

`autoApproveTick()` (the fully autonomous loop) does **not** call it — it
queries `status=eq.new` directly and approves from there, confirmed by a
full source read.

`bridgeActivationToExecution()`'s own sequence:

1. Calls the `activate_autopilot_recommendation` Postgres RPC, which
   atomically flips `autopilot_recommendations.status` `new → activated`
   and allocates a VTID.
2. Immediately calls `approveAutoExecute({finding_id})`, which RE-READS
   the row's `status` from the database and, before this fix, hard-rejected
   anything except `status === 'new'`.

Step 2 therefore rejected the exact write step 1 had just made, on every
single human-triggered activation, unconditionally. This is a pure
activation-ORDER bug: the caller transitions the row to `activated` and
then calls a function whose only accepted precondition is `new`.

**A second, related gap**, found in the same investigation: both human-facing
callers additionally gated their entire bridge ATTEMPT on
`!response.already_activated` — so even after fixing the root cause, a
finding already stranded at `status='activated'` from a prior (pre-fix)
activation could never be retried by clicking Activate again; the route/tool
would just report "Already activated as VTID-XXXXX" forever with no attempt
to recover.

## Why this triggered a standing governance rule, not just a fix

This defect lives inside the platform's own self-healing / self-improvement
machinery — the very system this whole platform exists to build. Raising it
as "worth its own ticket if you want it addressed?" instead of fixing it
immediately was identified by the platform owner as a categorical failure:
an autonomous self-healing system whose own operator asks a human whether to
fix something it just found broken in itself has failed at the one job it
exists to do. See CLAUDE.md Part 1 ALWAYS 10d/10e, NEVER 46, IF-THEN 10b
("Autonomous Defect-Fix Authority", STANDING RULE — VTID-04254) — grounded
in MAPE-K (autonomic self-healing: detect/diagnose/recover with no human
step) and the SRE "reactive remediation" pattern, and written in this file's
own enforced ALWAYS/NEVER/IF-THEN idiom (the same style as the pre-existing
VTID self-allocation rule, 2b) so it is structurally present for every
future session, not dependent on this session's memory.

## Fix

`services/gateway/src/services/dev-autopilot-execute.ts`:

- `ApprovalInput` gains an optional `alsoAllowStatus?: string` field.
- `approveAutoExecute()`'s status guard:
  `if (rec.status !== 'new')` → `if (rec.status !== 'new' && rec.status !== input.alsoAllowStatus)`.
  Not a wildcard: a status that is neither `'new'` nor the caller's exact
  opt-in value is still rejected.
- `bridgeActivationToExecution()`'s own call to `approveAutoExecute` passes
  `alsoAllowStatus: 'activated'` — the exact status its own prior RPC call
  just wrote. This is the ONLY call site that sets it.
- `autoApproveTick()` never sets it (confirmed by source-contract test) —
  structurally unaffected, exactly as designed.

`services/gateway/src/routes/autopilot-recommendations.ts` and
`services/gateway/src/services/operator-recommendation-tools.ts`: the
bridge-attempt condition changed from
`if (!response.already_activated && response.vtid) {` to
`if (response.vtid) {` — the bridge is now attempted on every call, retrying
a stranded finding instead of giving up after the first (pre-fix) failure.
The OTHER, legitimately-idempotency-sensitive occurrences of the same guard
text in both files (VTID-02935 alignment telemetry, draft-spec creation in
the route; OASIS activation-event emission in the operator tool) were
deliberately left untouched — retrying those would duplicate real side
effects (a second telemetry write, a second spec, a re-emitted OASIS event),
retrying the bridge does not (it has its own in-flight check on
`dev_autopilot_executions`).

`services/operator-recommendation-tools.ts`'s response `message` field: both
branches (`already_activated` and fresh) now append the execution-status
note, so a retried, now-successful bridge is reported to the operator
instead of the message staying frozen at "Already activated."

## Acceptance criteria

AC-1 `approveAutoExecute` rejects `status='activated'` when the caller does not opt in (autoApproveTick's unchanged behavior).
TEST: services/gateway/test/vtid-04254-activation-status-guard.test.ts — "still rejects status=\"activated\" when the caller does not opt in"

AC-2 `approveAutoExecute` accepts `status='activated'` when the caller passes `alsoAllowStatus: 'activated'` — the actual fix — and a real execution row is created.
TEST: services/gateway/test/vtid-04254-activation-status-guard.test.ts — "accepts status=\"activated\" when the caller passes alsoAllowStatus"

AC-3 `alsoAllowStatus` is not a wildcard: a status that is neither `'new'` nor the passed value is still rejected.
TEST: services/gateway/test/vtid-04254-activation-status-guard.test.ts — "alsoAllowStatus does not become a wildcard"

AC-4 `status='new'` still works with no opt-in at all (the common, unaffected path).
TEST: services/gateway/test/vtid-04254-activation-status-guard.test.ts — "status=\"new\" still works with no opt-in at all"

AC-5 The exact live failure (finding `9e1bdb97-…` at `status='activated'`, source_type `dev_autopilot`) now bridges to a real execution via `bridgeActivationToExecution` instead of the "only 'new' findings can be approved" error.
TEST: services/gateway/test/vtid-04254-activation-status-guard.test.ts — "reproduces and closes the exact live failure"

AC-6 `bridgeActivationToExecution` passes `alsoAllowStatus: 'activated'` to `approveAutoExecute`, alongside the existing `allowManualSourceTypes: true`.
TEST: services/gateway/test/vtid-04254-activation-status-guard.test.ts — "passes alsoAllowStatus: 'activated' to approveAutoExecute"

AC-7 `autoApproveTick` never sets `alsoAllowStatus` on any of its own `approveAutoExecute` calls (the invariant this fix must not break).
TEST: services/gateway/test/vtid-04254-activation-status-guard.test.ts — "its own approveAutoExecute call sites pass no alsoAllowStatus"

AC-8 Both human-facing activation callers (route, operator tool) no longer gate the bridge attempt on `!response.already_activated`, while the OTHER, deliberately-untouched `!already_activated` blocks in the same files remain at their expected occurrence count (2 in the route, 1 in the operator tool).
TEST: services/gateway/test/vtid-04254-activation-status-guard.test.ts — "the two human-facing activation callers retry the bridge on every call, not only the first" (4 assertions)

AC-9 The pre-existing operator-tool integration suite (`vtid-04111-operator-activate-recommendation.test.ts`), which previously pinned the BUGGY "does not attempt to bridge on an already-activated finding" behavior, now asserts the bridge retries and recovers, and a repeat call on an already-running execution is a safe no-op.
TEST: services/gateway/test/vtid-04111-operator-activate-recommendation.test.ts — "does not re-emit the OASIS event, but DOES retry the bridge" / "a repeat call on an already-running execution is a safe no-op"

AC-9b The pre-existing Command Hub `/activate` route suite (`test/routes/autopilot-recommendations.test.ts`), which also pinned the BUGGY "exactly 1 fetch call — the bridge never attempted" behavior for an already-activated recommendation, now asserts the bridge IS retried (a second fetch call, the bridge's own lookup) while the alignment-telemetry and draft-spec side effects (oasis_specs POST, vtid_ledger PATCH) stay skipped. Found by CI on the real PR — not caught by the local sweep that ran the sibling suites (vtid-04108/04111) but missed this one, the base route test file itself.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts — "already_activated: skips alignment/spec side effects, but DOES retry the bridge (VTID-04254)"

AC-10 No regression across the full related sweep (execution/onramp/watcher/reaper/source-type-allowlist suites that touch `dev-autopilot-execute.ts`, `autopilot-recommendations.ts`, or `operator-recommendation-tools.ts`, plus this fix's own two suites).
TEST: full local run, see commands.log — 41 suites, 457 tests, 0 failures.

## Results

| AC | Result |
|---|---|
| AC-1 | MET |
| AC-2 | MET |
| AC-3 | MET |
| AC-4 | MET |
| AC-5 | MET |
| AC-6 | MET |
| AC-7 | MET |
| AC-8 | MET |
| AC-9 | MET |
| AC-10 | MET |

`tsc --noEmit`: clean, no output.

## Not yet independently confirmed against live traffic

The fix is verified structurally (source-contract tests) and via the exact
live reproduction case replayed through mocks (AC-5), not yet against a
second real live Activate click on staging — this deploys via the normal
staging-first path (merge to `main` → `AWS-STAGE-DEPLOY-GATEWAY.yml`). The
real signal is finding VTID-04250 (`9e1bdb97-…`) actually bridging to a
real execution the next time Activate is clicked on staging after this
merges, per CLAUDE.md §16.
