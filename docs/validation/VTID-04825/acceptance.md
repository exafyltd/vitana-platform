# VTID-04825 — Jev P3 F (second slice): root cause per ended execution and the weekly roll-up, shadow

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 F — "root-cause class per finished execution/incident … weekly top classes
become findings". The first slice (VTID-04818) judged lessons before `dev_agent_memory`.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `execution_root_cause` (telemetry, `pii: 'redact'`, internal + autopilot planes, engineering roles): one choice over ten classes, from status, failure stage and the failure texts (error ≤400 chars, gate/bridge reasons, deploy error, failed check names), fix mode and whether a person cancelled — never plan bodies, diffs, logs or task ARNs.
  TEST: services/gateway/test/vtid-04825-root-cause-rollup.test.ts
AC-2: The rule `ruleRootCause` names a class from the same texts (quota/outage, scope violation, turn cap via the retry breaker's `TURN_CAP_FAILURE_RE`, merge conflict, deploy, verification, CI checks, cancelled) or leaves it open.
  TEST: services/gateway/test/vtid-04825-root-cause-rollup.test.ts
AC-3: Gate `root_cause_rollup` (`JEV_ROOT_CAUSE_ROLLUP_MODE`, exact values; anything else off). In shadow, once per UTC day: each execution that ended badly the day before (≤40), not classified in the last 30 days, gets one row (`subject_type = dev_autopilot_execution`, `system_action = rule_<class>|rule_none`), agreement at once where the rule names a class; Jev down → fallback row; never throws.
  TEST: services/gateway/test/vtid-04825-root-cause-rollup.test.ts
AC-4: Mondays (UTC): the last seven days' classes (Jev's, else the rule's; plus B3 `selfheal_pretriage` causes, unknown dropped) are counted; each class seen ≥3 times gets one rules row per week (`decision = rules:weekly_rollup`, `subject_type = root_cause_class`, `system_action = would_open_finding`, count and up to 5 example rows), no Jev call, no finding opened.
  TEST: services/gateway/test/vtid-04825-root-cause-rollup.test.ts
AC-5: The gateway starts the scheduler only when the mode is set; both gateways pin shadow, never enforce; generated pins agree; the B gates, the Jev foundation and the operator pipeline suites stay green.
  TEST: services/gateway/test/vtid-04825-root-cause-rollup.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/root-cause-rollup-gate.ts (new)
- services/gateway/src/services/jev/jev-repository.ts (two read functions)
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/index.ts (scheduler start, guarded)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin; prod in the Jev step from VTID-04824)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04825-root-cause-rollup.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04825/**

## OASIS

OASIS_IMPACT: none new. Each classified execution emits the existing `jev.decision.*` event (source `jev:gate:root_cause_rollup`); the weekly roll-up makes no Jev call.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_ROOT_CAUSE_ROLLUP_MODE=shadow`. Reads executions and shadow rows,
writes only `jev_shadow_decisions`. Dev Autopilot behaves exactly as before.

## Not in this PR

Enforce: opening a `dev_autopilot` finding per weekly class.
