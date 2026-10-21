# VTID-04800 — Jev P2 A6: Dev Autopilot CI failure routing, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A6 (P2). Uses the existing `ci_failure_bucket` decision
(VTID-04473) unchanged.

Evidence (read-only, 30 days to 2026-10-01): 42 `dev_autopilot.execution.ci_failed` events; of the named
failing checks, `validate-pr` 8, `Gateway Service Tests` 6, `Gateway (Jest)` 2, `Path Ownership Guard` 2,
`Test Suite Summary` 2, `change-suite` 1. Every one went to self-healing fix mode, whatever failed —
a governance gate (evidence pack) is not fixed by re-running the coding agent on the code.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: A rule bucket per failing check: governance checks by name (validate-pr, change-suite, scan, Path Ownership Guard, naming/docs/structure guards); otherwise from well-known log lines — infrastructure (runner lost/shutdown, cancelled, 502–504, ECONNRESET), dependency (npm ERR!, ERESOLVE), type_error (`error TS`), lint (eslint problems), test_failure (Jest FAIL/●/Tests: n failed); null when unsure.
  TEST: services/gateway/test/vtid-04800-ci-failure-routing.test.ts
AC-2: Gate `ci_failure_routing` (`JEV_CI_FAILURE_ROUTING_MODE`, exact values; anything else off). Off asks and writes nothing. In shadow, each failing check with a usable log excerpt (at most 3) is sent to `ci_failure_bucket` (check name + bounded excerpt). No usable excerpt → nothing asked.
  TEST: services/gateway/test/vtid-04800-ci-failure-routing.test.ts
AC-3: One `jev_shadow_decisions` row per execution (subject = its id) with Jev's and the rules' bucket per check; `system_action = self_heal_fix_mode`. Where the rules named a bucket, agreement is written at once (all compared checks match); otherwise agreed is null. Jev unavailable → a fallback row; a throwing call → nothing; never throws.
  TEST: services/gateway/test/vtid-04800-ci-failure-routing.test.ts
AC-4: The gate runs in the watcher's CI-failed branch after the log evidence is collected and before the self-heal bridge, never awaited; the transition, the event and the bridge are unchanged.
  TEST: services/gateway/test/vtid-04800-ci-failure-routing.test.ts
  TEST: services/gateway/test/dev-autopilot-watcher.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-5: Both gateways pin `JEV_CI_FAILURE_ROUTING_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04800-ci-failure-routing.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/ci-failure-gate.ts (new)
- services/gateway/src/services/dev-autopilot-watcher.ts (one fire-and-forget call)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04800-ci-failure-routing.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04800/**

## OASIS

OASIS_IMPACT: none new. Each check emits the existing `jev.decision.*` event (source `jev:gate:ci_failure_routing`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_CI_FAILURE_ROUTING_MODE=shadow`. The watcher behaves exactly as before.

## Not in this PR

Enforce (sending a governance failure to an evidence-pack fix, re-running an infrastructure failure once
instead of fix mode) comes after the agreement data.
