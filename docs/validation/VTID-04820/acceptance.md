# VTID-04820 — Jev P3 E10: partner onboarding triage on submit, shadow (advisory)

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 E10 (P3).

When a partner submits its onboarding, the rules decide: every required checklist step done → live, otherwise
needs_action. They check each step, not whether the application hangs together (a legal name that does not fit the
website, a regulated vertical, a catalogue on paper only).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `partner_onboarding_triage` (business data, `pii: 'redact'`, internal plane, backoffice roles): ready to go live, and the main concern (none / verification gap / identity mismatch / category risk / incomplete setup / unclear).
  TEST: services/gateway/test/vtid-04820-partner-onboarding-triage.test.ts
AC-2: Jev sees business facts only — partner type, vertical, legal name, country, website host, whether a VAT id exists (never the number), the required verification level and the checklist (step, required, status, missing codes) — and the rules' outcome; never owners, members or contact persons.
  TEST: services/gateway/test/vtid-04820-partner-onboarding-triage.test.ts
AC-3: Gate `partner_onboarding_triage` (`JEV_PARTNER_ONBOARDING_TRIAGE_MODE`, exact values; anything else off). Off, or no tenant on the caller, asks and writes nothing. In shadow, after submit's state moves, under the submitting user's active tenant, one `jev_shadow_decisions` row (`subject_type = partner_organization`, `system_action = submit_<outcome>`); agreement at once with the rules (ready ↔ live); abstained → null; Jev down → fallback row; never throws.
  TEST: services/gateway/test/vtid-04820-partner-onboarding-triage.test.ts
AC-4: The submit, its moves, events and response are unchanged (partner onboarding suites green); both gateways pin `JEV_PARTNER_ONBOARDING_TRIAGE_MODE=shadow`, never enforce; generated pins agree; the prod task-definition step stays under GitHub's per-step limit.
  TEST: services/gateway/test/vtid-04820-partner-onboarding-triage.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/partner-triage-gate.ts (new)
- services/gateway/src/routes/partner-onboarding.ts (one fire-and-forget call after submit, one import)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04820-partner-onboarding-triage.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04820/**

## OASIS

OASIS_IMPACT: none new. Each submit emits the existing `jev.decision.*` event (source `jev:gate:partner_onboarding_triage`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_PARTNER_ONBOARDING_TRIAGE_MODE=shadow`. Partner onboarding behaves exactly as before.

## Not in this PR

Enforce (showing the triage to the reviewer); KYB and approval stay human.
