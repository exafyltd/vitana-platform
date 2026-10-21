# VTID-04803 — Jev P2 B6: Dev Autopilot fix verification second opinion, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 B6 (P2).

The watcher's verification verdict (dev-autopilot-watcher.ts) is rules: no error events attributable to other
work in the 30-minute window after deploy (VTID-04377 baseline, VTID-04625 min-excess), plus a re-probe of the
finding's HTTP endpoint when it has one. A finding with no probeable endpoint — most code-quality findings —
passes on "no new errors" alone, which does not show the original problem is gone.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `fix_verification` (telemetry, planes internal + system_autopilot, engineering roles): "is the finding's problem resolved by this change" and "is the evidence enough to tell", from the finding title/summary, the plan's file paths and a plain summary of the rules' verdict — never code.
  TEST: services/gateway/test/vtid-04803-fix-verification.test.ts
AC-2: Gate `fix_verification` (`JEV_FIX_VERIFICATION_MODE`, exact values; anything else off). Off loads, asks and writes nothing.
  TEST: services/gateway/test/vtid-04803-fix-verification.test.ts
AC-3: Asked at every verdict — pass, blast-radius fail, re-probe fail — one `jev_shadow_decisions` row per execution next to the rules' state (`system_action = verification_pass|fail`), with whether the finding was probed. Agreement at once: Jev "resolved" ↔ rules pass. Abstained or unavailable → agreed null; no finding → nothing; never throws.
  TEST: services/gateway/test/vtid-04803-fix-verification.test.ts
AC-4: The check runs before the self-heal bridge (fails) and before the completion (pass), never awaited; transitions, events and the bridge are unchanged (watcher, verification and operator pipeline suites green).
  TEST: services/gateway/test/vtid-04803-fix-verification.test.ts
  TEST: services/gateway/test/dev-autopilot-watcher.test.ts
  TEST: services/gateway/test/vtid-04377-verification-baseline.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-5: Both gateways pin `JEV_FIX_VERIFICATION_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04803-fix-verification.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/fix-verification-gate.ts (new)
- services/gateway/src/services/dev-autopilot-watcher.ts (three fire-and-forget calls + one loader)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04803-fix-verification.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04803/**

## OASIS

OASIS_IMPACT: none new. Each check emits the existing `jev.decision.*` event (source `jev:gate:fix_verification`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_FIX_VERIFICATION_MODE=shadow`. Verification behaves exactly as before.

## Not in this PR

Enforce (holding a pass Jev doubts on an unprobed finding for a human) comes after the data.
