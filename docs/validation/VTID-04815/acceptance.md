# VTID-04815 — Jev P3 A9: per-change risk score for Dev Autopilot diffs, shadow (advisory)

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A9 (P3).

The only risk signal on a Dev Autopilot change is the finding's `risk_class`, set by the scanner before any code
exists. Nothing reads the change the agent actually produced — how many files, shared or central code, how much is
tested — before it merges and deploys.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `change_risk` (telemetry, `pii: 'redact'`, planes internal + system_autopilot, engineering roles): a four-level score (low / moderate / high / very high) from the finding title and class, the changed paths, the diff stat, a bounded patch excerpt (≤ 8,000 chars), the number of test files in the diff and the fix rounds.
  TEST: services/gateway/test/vtid-04815-change-risk.test.ts
AC-2: Gate `change_risk` (`JEV_CHANGE_RISK_MODE`, exact values; anything else off). Off asks and writes nothing. In shadow, after the runner pushes a new change (never a fix-mode push) and before the PR opens, one `jev_shadow_decisions` row per execution (`system_action = pushed`); never awaited; Jev down → a fallback row; never throws.
  TEST: services/gateway/test/vtid-04815-change-risk.test.ts
AC-3: The outcome is how the change landed: CI failed for a reason other than a dirty merge (`ci_failed`), or the post-deploy verification verdict (`verification_failed` / `verification_passed`); the first landing wins. "High" or worse agrees with a bad landing; abstained → agreed null.
  TEST: services/gateway/test/vtid-04815-change-risk.test.ts
AC-4: The runner, the PR and the watcher behave as before (runner, watcher and operator pipeline suites green). `fetchRecentShadowRow` additionally returns the row's `outcome` (additive).
  TEST: services/gateway/test/vtid-04815-change-risk.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-5: Both gateways pin `JEV_CHANGE_RISK_MODE=shadow`, never enforce; generated pins agree; the prod task-definition step stays under GitHub's per-step limit.
  TEST: services/gateway/test/vtid-04815-change-risk.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/jev-repository.ts (one extra selected column)
- services/gateway/src/services/jev/gates/change-risk-gate.ts (new)
- services/gateway/src/services/autopilot-agent/run-agent-execution.ts (one guarded, fire-and-forget block)
- services/gateway/src/services/dev-autopilot-watcher.ts (two fire-and-forget outcome calls)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04815-change-risk.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04815/**

## OASIS

OASIS_IMPACT: none new. Each pushed change emits the existing `jev.decision.*` event (source `jev:gate:change_risk`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_CHANGE_RISK_MODE=shadow`. The runner, PRs and the watcher behave exactly as before. Rows come from wherever the agent runs; the ECS executor task needs the TypeSafe secret first (owner check, pending).

## Not in this PR

Enforce (showing the score next to the PR / approval) comes after the data.
