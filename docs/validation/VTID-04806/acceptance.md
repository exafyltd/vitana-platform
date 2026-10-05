# VTID-04806 — Jev P2 A3: Dev Autopilot finding plannability check, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A3 (P2).

The planner spends a full LLM session on every finding it plans. In the 30 days to 2026-10-01 there were 82
first plans and 77 follow-up versions (someone sent the plan back), plus ~180 planner failures. Some findings
are not plannable as written: too vague, too broad, waiting on a decision, or with no location in the code.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `finding_plannable` (`pii: 'redact'`, planes internal + system_autopilot, engineering roles): "is this finding specific and bounded enough to plan" and the main blocker (none, too vague, too broad, needs a human decision, missing location), from the finding's title, summary, domain, risk class, signal type, suggested action and file hints.
  TEST: services/gateway/test/vtid-04806-plannability.test.ts
AC-2: Gate `plannability` (`JEV_PLANNABILITY_MODE`, exact values; anything else off). Off asks and writes nothing.
  TEST: services/gateway/test/vtid-04806-plannability.test.ts
AC-3: On a first-time plan only (never a continue-planning call), the check starts before the planner session and is never awaited before it; one `jev_shadow_decisions` row per finding (`system_action = planner_ran`).
  TEST: services/gateway/test/vtid-04806-plannability.test.ts
AC-4: On every exit of plan generation the row's outcome is recorded: plan with files (agrees with plannable), plan without files or a planner failure (agrees with not plannable), an infrastructure error (agreed null). Abstained or unavailable → agreed null; never throws.
  TEST: services/gateway/test/vtid-04806-plannability.test.ts
AC-5: Planning behaves exactly as before (planner suites and operator pipeline suite green); both gateways pin `JEV_PLANNABILITY_MODE=shadow`, never enforce; generated pins agree; the prod task-definition step stays under GitHub's per-step limit.
  TEST: services/gateway/test/vtid-04806-plannability.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/plannability-gate.ts (new)
- services/gateway/src/services/dev-autopilot-planning.ts (one fire-and-forget start, three outcome calls)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04806-plannability.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04806/**

## OASIS

OASIS_IMPACT: none new. Each check emits the existing `jev.decision.*` event (source `jev:gate:plannability`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_PLANNABILITY_MODE=shadow`. Planning behaves exactly as before.

## Not in this PR

Enforce (skipping or flagging the planner for a finding Jev calls unplannable) comes after the data.
