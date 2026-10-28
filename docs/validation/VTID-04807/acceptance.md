# VTID-04807 — Jev P2 A5: test-suite selection for the Dev Autopilot diff, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A5 (P2).

Before opening a PR the agent runner re-runs tsc and the jest suites paired to the changed files by name, plus
the suites that read a changed frontend asset (VTID-04617). A suite that imports a changed module under another
name first runs in CI: "Gateway Service Tests" / "Gateway (Jest)" failed 8 of the ~42 Dev Autopilot CI failures
in the 30 days to 2026-10-01.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `test_suite_relevance` (`pii: 'redact'`, planes internal + system_autopilot, engineering roles): "would this suite likely catch a regression from this change", from the change title, the changed paths, the suite's path, the changed modules it imports and its describe/test titles.
  TEST: services/gateway/test/vtid-04807-test-selection.test.ts
AC-2: Candidates are the suites under `<project>/test` that import a changed source module (by import/require path stem) and that the runner does not already run (not a changed test, not name-paired); near-miss stems do not match; at most 8, most imports first; listed synchronously while the clone exists.
  TEST: services/gateway/test/vtid-04807-test-selection.test.ts
AC-3: Gate `test_selection` (`JEV_TEST_SELECTION_MODE`, exact values; anything else off). Off asks and writes nothing. In shadow, after the runner's checks pass and before the PR contract, one `jev_shadow_decisions` row per execution with each candidate's verdict and Jev's picks (`system_action = runner_paired_suites_only`); never awaited; Jev unavailable → a fallback row; never throws.
  TEST: services/gateway/test/vtid-04807-test-selection.test.ts
AC-4: On CI pass the row's outcome is `ci_passed`; on CI failure the failing jest suites are read from the log excerpts (`FAIL …test.ts`): one Jev picked → agreed true, one Jev skipped → agreed false, none among the candidates or no jest failure → agreed null.
  TEST: services/gateway/test/vtid-04807-test-selection.test.ts
AC-5: What the runner runs, the PR and the watcher's routing are unchanged (runner, watcher and operator pipeline suites green); both gateways pin `JEV_TEST_SELECTION_MODE=shadow`, never enforce; generated pins agree; the prod task-definition step stays under GitHub's per-step limit.
  TEST: services/gateway/test/vtid-04807-test-selection.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/test-selection-gate.ts (new)
- services/gateway/src/services/autopilot-agent/run-agent-execution.ts (one guarded, fire-and-forget block)
- services/gateway/src/services/dev-autopilot-watcher.ts (two fire-and-forget outcome calls)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04807-test-selection.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04807/**

## OASIS

OASIS_IMPACT: none new. Each judged suite emits the existing `jev.decision.*` event (source `jev:gate:test_selection`), at most 8 per execution.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_TEST_SELECTION_MODE=shadow`. The runner, the PR and CI routing behave exactly as before. Like A1, rows come from wherever the agent runs; the ECS executor task needs read access to the TypeSafe secret first (owner check, pending).

## Not in this PR

Enforce (running Jev's picks in the runner before the PR opens) comes after the data.
