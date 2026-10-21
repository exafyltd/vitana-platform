# VTID-04667 — Autopilot recommendations P4: stop spending tokens on work that does not land

Phase P4 of `docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md`.

## Why

Live, last 30 days (plan §2):

- The todo, safety-gap, npm-audit, missing-tests, schema-drift, route-auth,
  stale-flag and dead-code scanners produced **74 executions and 0 completed**.
- One impact finding (`impact:new-env-var-requires-workflow-binding`) ran
  **467 executions in ~14 h** during the 22–23 Sept provider outage
  (`LLM call failed … both providers failed: primary=Bedrock invoke_failed /
  DeepSeek 402`).
- The agent executor used **641 M input tokens**; almost none of it produced
  a merged change from a scanner finding.

What already existed: the per-finding retry breaker (VTID-04243 turn cap,
`AUTO_RETRY_CAP`) and the global outage gate (VTID-04368). The retry breaker
excludes outage failures on purpose, and the outage gate's `probe` state lets
one execution through per tick — so during a long outage the same finding
could be that probe on every tick. Nothing stopped a scanner whose findings
never land, nothing bounded a finding's total agent spend, and the Command
Hub offered "Activate" for recommendation types that have no executor.

## Fix

1. **Per-scanner / per-rule circuit breaker** —
   `services/gateway/src/services/dev-autopilot-scanner-breaker.ts`.
   Key = `spec_snapshot.scanner` (`impact:<rule>` for impact findings; a rule
   without a scanner becomes `impact:<rule>`; else `source_type`). Success =
   `completed` / `self_healed`; failure = `failed*` / `reverted`;
   `cancelled`, `rejected`, in-flight and outage-class failures
   (`isProviderOutageFailure`, VTID-04368) are ignored. Open when ≥ 5 decided
   samples among the newest 10 and success < 20 %
   (`DEV_AUTOPILOT_BREAKER_MIN_SAMPLES` / `_WINDOW` / `_MIN_SUCCESS_RATE`).
   While open, `autoApproveTick` (both passes) and `lazyPlanTick` skip that
   scanner's findings — no execution and no planner spend. One OASIS event
   per transition (`dev_autopilot.scanner_breaker.opened` / `.closed`,
   latched per process like the VTID-04368 outage gate). A read failure fails
   open. `operator_onramp` findings (a person asked for them) are never
   paused. A human Activate (`bridgeActivationToExecution`) does not pass
   through these ticks and is not blocked. The supervisor snapshot
   (`GET /api/v1/dev-autopilot/supervisor`) carries `scanner_breakers`
   (thresholds, open keys, every key's samples/successes/rate), a warning
   alert naming paused scanners, and a `scanner_breaker_open` diagnosis on
   each affected open finding.
2. **Pre-approval plan checks (autonomous approvals only)** — a `large_file`
   finding is never `auto_exec_eligible` at synthesis and `autoApproveTick`
   skips it even if its risk class is opted in. The safety gate's
   `tests_missing` rule already refuses a plan with non-deletion edits and no
   test file (verified in `dev-autopilot-safety.ts`, rule 4 — left as is). A
   plan whose non-test code files are not in the codebase index
   (`loadCodeIndex`, VTID-04229) is skipped for that tick (not snoozed); the
   check is skipped when the index cannot load (3 s bound, retried after
   10 min), when `DEV_AUTOPILOT_PLAN_FILE_CHECK=false`, or when
   `AGENT_CODE_INDEX_ENABLED=false`.
3. **Per-finding token budget** — the finding's agent spend is summed across
   its `dev_autopilot_outcomes` rows (`metadata.agent_runs[]`, deduplicated
   by execution id, and `agent_cost_usd_total`, VTID-04017). At ≥ $3 or
   ≥ 5 M input tokens (`DEV_AUTOPILOT_FINDING_BUDGET_USD` /
   `_INPUT_TOKENS`) the finding is snoozed 7 days with the existing
   `dev_autopilot.finding.snoozed` event (VTID-04243), `reason: 'token_budget'`.
4. **Outage requeue cap** — a finding whose newest execution failed with an
   outage-class error less than 60 minutes ago
   (`DEV_AUTOPILOT_OUTAGE_REQUEUE_MINUTES`) is not re-approved; it is skipped,
   not snoozed. Applied in both passes.
5. **Non-executable types in the Command Hub** — the Pending Approvals modal
   card and the Overview card show **"Create task"** instead of "Activate"
   for any `source_type` not in `MANUALLY_BRIDGEABLE_SOURCE_TYPES` (mirrored
   in `app.js` as `EXECUTABLE_REC_SOURCE_TYPES`; a drift test parses both).
   `queryRecommendationsByRole` and the pipeline summary now select
   `source_type`. Unknown/missing type keeps "Activate". `?v=` bumped to
   `20261016-vtid-04667`; symbol index regenerated.

## Acceptance criteria

AC-1 A scanner with ≥ 5 decided executions among its last 10 and < 20 % success is breaker-open; outage failures, cancellations and rejections never count; thresholds are env-overridable.
TEST: services/gateway/test/vtid-04667-scanner-breaker.test.ts

AC-2 autoApproveTick (baseline and impact) and lazyPlanTick skip findings of an open scanner/rule; other scanners proceed.
TEST: services/gateway/test/vtid-04667-auto-approve-gates.test.ts

AC-3 Exactly one OASIS event per breaker transition (opened, then closed on recovery).
TEST: services/gateway/test/vtid-04667-scanner-breaker.test.ts

AC-4 The supervisor snapshot exposes breaker state: alert naming paused scanners and a per-finding `scanner_breaker_open` diagnosis.
TEST: services/gateway/test/vtid-04667-scanner-breaker.test.ts

AC-5 large_file findings are never auto_exec_eligible and never auto-approved.
TEST: services/gateway/test/vtid-04667-approval-gates.test.ts
TEST: services/gateway/test/vtid-04667-auto-approve-gates.test.ts

AC-6 A plan naming non-test code files missing from the codebase index is not auto-approved; the check is off when switched off or when the index cannot load.
TEST: services/gateway/test/vtid-04667-auto-approve-gates.test.ts

AC-7 A finding over its agent budget ($3 / 5 M input tokens) is snoozed 7 days with dev_autopilot.finding.snoozed reason token_budget.
TEST: services/gateway/test/vtid-04667-auto-approve-gates.test.ts

AC-8 A finding whose last execution failed on a provider outage < 60 min ago is not re-approved (both passes), and is approved again after the cooldown.
TEST: services/gateway/test/vtid-04667-auto-approve-gates.test.ts

AC-9 Command Hub shows "Create task" for recommendation types without an executor; the app.js list matches MANUALLY_BRIDGEABLE_SOURCE_TYPES; listings select source_type.
TEST: services/gateway/test/vtid-04667-executable-source-types-drift.test.ts

AC-10 The operator pipeline regression suite stays green (turn-cap snooze, outage gate, auto-approve).
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## OASIS

OASIS_PROOF: new event types `dev_autopilot.scanner_breaker.opened` (status
`warning`) and `dev_autopilot.scanner_breaker.closed` (status `info`),
vtid `VTID-04667`, payload `{ key, samples, successes, success_rate,
thresholds }`, registered in `CicdEventType`. Emission of exactly one event
per transition is asserted in
`services/gateway/test/vtid-04667-scanner-breaker.test.ts`
("reads decided executions … emitting opened once", "emits closed when the
scanner recovers") and in the tick itself in
`services/gateway/test/vtid-04667-auto-approve-gates.test.ts`. The token
budget reuses `dev_autopilot.finding.snoozed` with `reason: 'token_budget'`
(asserted in the same suite).

## Not verified live

- No autonomous approval was run on staging: an approval writes executions
  and snoozes findings in the production database that staging shares.
- The breaker's first real readings, and whether the live 30-day history
  opens todo / safety-gap / npm-audit as the plan expects, are visible in the
  supervisor snapshot (`scanner_breakers`) once this deploys.
- The plan-file check depends on the S3 code index (VTID-04229); if the
  gateway task role cannot read it, the check logs once per 10 min and is
  skipped.
