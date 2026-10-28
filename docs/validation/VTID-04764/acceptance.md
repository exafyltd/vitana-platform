# VTID-04764 — Jev P1 A1: Dev Autopilot agent progress check, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A1. Builds on VTID-04754 (framework) and VTID-04759 (gate pattern).

Evidence (14 days to 2026-09-30): the autopilot agent made 13,256 calls on
650M input tokens ($151); 21 of 675 executions completed; 75 runs ran into
the turn cap (≈$100). The loop's own rules catch "no edit yet" (exploration
budget, VTID-04466) and "the same call again" (progress ledger, VTID-04394);
nothing judges a run that edits but never converges.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: A new decision `agent_progress_check` (telemetry, planes internal + system_autopilot, engineering roles) asks continue / commit / handoff / stop plus "will it finish", from the task summary, the run's counters and a window of its own tool activity — never file contents or member data.
  TEST: services/gateway/test/vtid-04764-agent-progress-gate.test.ts
AC-2: `runAgentLoop` emits one observe-only snapshot per completed tool turn (turn, counters, idle turns, the loop's own chosen action, the turn's calls); the hook is not awaited and a throw changes nothing.
  TEST: services/gateway/test/vtid-04764-agent-progress-gate.test.ts
  TEST: services/gateway/test/autopilot-agent-loop.test.ts
AC-3: Gate `agent_progress` (`JEV_AGENT_PROGRESS_MODE`, exact `shadow`/`enforce`, anything else off): off is a no-op object; shadow asks Jev every `JEV_AGENT_PROGRESS_EVERY` turns (default 10, min 3), in order, with the last 30 calls and the passed/failed check counts, and records one `jev_shadow_decisions` row per check next to the loop's own action.
  TEST: services/gateway/test/vtid-04764-agent-progress-gate.test.ts
AC-4: When the run ends (runner `finally`, every exit path), each check gets the outcome and `agreed`: continue/commit and the run opened its PR (or held for approval / pushed its fix), or handoff/stop and the run failed. A cancelled run, an abstention or a failed Jev call records `agreed = null`. A failing Jev client never reaches the loop.
  TEST: services/gateway/test/vtid-04764-agent-progress-gate.test.ts
AC-5: With the gate off the Dev Autopilot pipeline is unchanged (worker-call counts, turn-cap snooze, golden path).
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04466-exploration-budget.test.ts
  TEST: services/gateway/test/vtid-04394-progress-ledger.test.ts
AC-6: Both gateways pin `JEV_AGENT_PROGRESS_MODE=shadow` (in-process agent runs). The ECS executor task (`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`) is deliberately NOT wired in this PR: adding the TypeSafe secret to a task whose execution role cannot read it would stop every executor task from starting. It is wired after the owner confirms the role can read the secret.
  TEST: services/gateway/test/vtid-04764-agent-progress-gate.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/agent-progress-gate.ts (new)
- services/gateway/src/services/autopilot-agent/agent-loop.ts (observe-only hook)
- services/gateway/src/services/autopilot-agent/run-agent-execution.ts (gate wiring)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04764-agent-progress-gate.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04764/**

## OASIS

OASIS_IMPACT: none new. Each check emits the existing `jev.decision.*` event (source `jev:gate:agent_progress`); rows go to `jev_shadow_decisions`.

## Not in this PR

Enforce (acting on handoff/stop) is P2, after the agreement rate is known. The executor wiring waits on the owner's secret-access check.
