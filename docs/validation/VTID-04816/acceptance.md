# VTID-04816 — Jev P3 A10: Operator Console turn router, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A10 (P3).

Every Operator Console turn sends the model the whole role-filtered tool catalog (~60 tools) and lets it pick. A
turn that only needs an answer, or only a code lookup, still pays for every tool definition and can pick the wrong one.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `operator_route` (`pii: 'redact'`, internal plane, engineering roles): which lane a message asks for — answer only, task management, code lookup, ops diagnostics, delivery, community — from the message and whether developer tools are available.
  TEST: services/gateway/test/vtid-04816-operator-route.test.ts
AC-2: Every tool in the operator's `executeTool` has a lane (`TOOL_LANES`), and every lane is one the decision knows; a new tool without a lane fails the test. The lane a turn took is the most frequent lane of its tool calls (first wins a tie), answer only when none, null when only unknown tools.
  TEST: services/gateway/test/vtid-04816-operator-route.test.ts
AC-3: Gate `operator_route` (`JEV_OPERATOR_ROUTE_MODE`, exact values; anything else off). Off asks and writes nothing. In shadow, started before the turn and never awaited before it; one `jev_shadow_decisions` row per turn (`subject_type = operator_thread`, `system_action = full_tool_catalog`); the outcome after the (possibly retried) turn: `turn_lane:<lane>` and whether Jev's lane matched; abstained / unavailable / unknown → null; never throws.
  TEST: services/gateway/test/vtid-04816-operator-route.test.ts
AC-4: The turn, its tools and its reply are unchanged (operator route, operator pipeline and role-separation suites green); both gateways pin `JEV_OPERATOR_ROUTE_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04816-operator-route.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/operator-route-gate.ts (new)
- services/gateway/src/routes/operator.ts (one fire-and-forget start, one outcome call, one import)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04816-operator-route.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04816/**

## OASIS

OASIS_IMPACT: none new. Each operator turn emits the existing `jev.decision.*` event (source `jev:gate:operator_route`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_OPERATOR_ROUTE_MODE=shadow`. Operator turns behave exactly as before.

## Not in this PR

Enforce (sending only the lane's tools, or a cheaper model for answer-only turns) comes after the data.
