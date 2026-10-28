# VTID-04801 — Jev P2 A4: Dev Autopilot repeat-run guard, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A4 (P2). Builds on A2 (VTID-04774), which sits at the same claim point.

Evidence (read-only, 30 days to 2026-10-01): 685 executions for 142 findings, 22 completed, 619 auto-archived;
45 findings ran more than once, one 467 times (the 2026-09-22 outage loop, since stopped by VTID-04368). The
retry cap, the turn-cap breaker (VTID-04243) and the outage stop bound how often a finding is retried; none
of them can see whether the new attempt does anything different.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `execution_repeat` (telemetry, planes internal + system_autopilot, engineering roles): "is the new plan materially the same approach as the failed one, with nothing addressing its failure" plus "will it succeed", from the finding title, the previous plan, the previous failure text and the new plan — plans and failure text only.
  TEST: services/gateway/test/vtid-04801-repeat-run-guard.test.ts
AC-2: Gate `repeat_run_guard` (`JEV_REPEAT_RUN_GUARD_MODE`, exact values; anything else off). Off loads, asks and writes nothing. No failed attempt (failed / failed_escalated / auto_archived / reverted) of the same finding in the last 7 days → no row.
  TEST: services/gateway/test/vtid-04801-repeat-run-guard.test.ts
AC-3: Same plan version as the failed attempt → a rules row (`repeat = true`), no Jev call. A different plan version → Jev compares both plans and the previous failure. One `jev_shadow_decisions` row per execution (subject = its id), `system_action = dispatch`. A throwing loader or call never throws and writes nothing.
  TEST: services/gateway/test/vtid-04801-repeat-run-guard.test.ts
AC-4: Outcome from every applied result: "repeat" agrees with a failed run, "not a repeat" with an opened/held PR; a cancelled run or an abstained verdict → agreed null; no row → nothing.
  TEST: services/gateway/test/vtid-04801-repeat-run-guard.test.ts
AC-5: The check runs at the claim beside A2, before dispatch, never awaited; the claim and dispatch are unchanged (operator pipeline suite green).
  TEST: services/gateway/test/vtid-04801-repeat-run-guard.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04774-claim-feasibility-gate.test.ts
AC-6: Both gateways pin `JEV_REPEAT_RUN_GUARD_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04801-repeat-run-guard.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/repeat-run-gate.ts (new)
- services/gateway/src/services/dev-autopilot-execute.ts (claim hook, result hook, context loader)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04801-repeat-run-guard.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04801/**

## OASIS

OASIS_IMPACT: none new. Each Jev check emits the existing `jev.decision.*` event (source `jev:gate:repeat_run_guard`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_REPEAT_RUN_GUARD_MODE=shadow`. Claims and dispatch behave exactly as before.

## Not in this PR

Enforce (holding a repeat with the previous failure attached instead of dispatching it) comes after the data.
