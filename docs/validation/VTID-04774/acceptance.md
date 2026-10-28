# VTID-04774 — Jev P1 A2: feasibility check at the Dev Autopilot claim, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A2. Builds on VTID-04754, VTID-04759, VTID-04764.

Evidence (14 days to 2026-09-30): 21 of 675 executions completed. Many fail on
things no amount of agent turns can fix (a missing secret, an AWS change, an
open-ended ask). A2 asks before the run starts.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `execution_feasibility` (telemetry, planes internal + system_autopilot, engineering roles): feasible / needs_human / needs_infra / too_large / unclear plus "will it succeed", from the finding title, plan excerpt, file paths, fix mode, prior failure, risk class and source — never file contents or member data.
  TEST: services/gateway/test/vtid-04774-claim-feasibility-gate.test.ts
AC-2: Gate `claim_feasibility` (`JEV_CLAIM_FEASIBILITY_MODE`, exact values; anything else off): off loads, asks and writes nothing; shadow writes one `jev_shadow_decisions` row per execution (subject = execution id) next to `dispatch`. A missing plan, a throwing loader or a throwing client never throws and writes no row.
  TEST: services/gateway/test/vtid-04774-claim-feasibility-gate.test.ts
AC-3: The check runs in `backgroundExecutorTick` after the atomic claim and the `execution.running` event, before dispatch, and is never awaited — the claim and dispatch are unchanged. It covers every execution, including self-heal and fix-mode children that skip approval.
  TEST: services/gateway/test/vtid-04774-claim-feasibility-gate.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04467-dispatch-fallback.test.ts
AC-4: Every applied result (`applyExecutionResult`, ECS task or in-process) writes the outcome first, fire-and-forget: feasible + PR opened/held → agreed; any blocker + failed → agreed; otherwise disagreed; cancelled or abstained → null; no row → nothing.
  TEST: services/gateway/test/vtid-04774-claim-feasibility-gate.test.ts
AC-5: Both gateways pin `JEV_CLAIM_FEASIBILITY_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04774-claim-feasibility-gate.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/claim-feasibility-gate.ts (new)
- services/gateway/src/services/jev/jev-repository.ts (one lookup)
- services/gateway/src/services/dev-autopilot-execute.ts (claim hook, result hook, context loader)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04774-claim-feasibility-gate.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04774/**

## OASIS

OASIS_IMPACT: none new. Each check emits the existing `jev.decision.*` event (source `jev:gate:claim_feasibility`).

## Not in this PR

Enforce (holding an infeasible execution with a named blocker instead of dispatching it) is P2, after the agreement rate is known.
