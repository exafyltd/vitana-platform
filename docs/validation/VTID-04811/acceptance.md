# VTID-04811 — Jev P2 E7: approval risk hint for queued High-risk Backoffice commands, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 E7 (P2).

A High-risk Backoffice command (cancelling an invoice or a payment, a payment above the tenant's threshold, …)
waits for a second person with the approve capability. Nothing tells the approver whether it looks routine or wrong.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `approval_risk` (business data, `pii: 'redact'`, internal plane, backoffice roles): a four-level risk score (routine / some risk / high risk / looks wrong) from the command type, action, escalations, business fields and payload field names.
  TEST: services/gateway/test/vtid-04811-approval-risk.test.ts
AC-2: Only an allow-list of business values is sent (amount, currency, kind, payment type and mode, dates, references, company, cost center, account number) plus line counts; every other payload field by name only; never the requester, a counterparty's name or free-text remarks; payroll-tagged commands are never sent.
  TEST: services/gateway/test/vtid-04811-approval-risk.test.ts
AC-3: Gate `approval_risk` (`JEV_APPROVAL_RISK_MODE`, exact values; anything else off). Off asks and writes nothing. In shadow, one `jev_shadow_decisions` row per queued approval (`subject_type = backoffice_approval`, `system_action = queued_for_approval`), after the approval exists, never awaited; Jev down → a fallback row; never throws.
  TEST: services/gateway/test/vtid-04811-approval-risk.test.ts
AC-4: When the approver decides, the row records `approver_approved` / `approver_rejected`: "high risk" or worse agrees with a rejection, a lower level agrees with an approval; abstained or unavailable → agreed null.
  TEST: services/gateway/test/vtid-04811-approval-risk.test.ts
AC-5: Queueing, approval and the responses are unchanged (Backoffice suites green); both gateways pin `JEV_APPROVAL_RISK_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04811-approval-risk.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/approval-risk-gate.ts (new)
- services/gateway/src/services/backoffice/command-orchestrator.ts (three fire-and-forget calls)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04811-approval-risk.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04811/**

## OASIS

OASIS_IMPACT: none new. Each queued approval emits the existing `jev.decision.*` event (source `jev:gate:approval_risk`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_APPROVAL_RISK_MODE=shadow`. Approvals behave exactly as before; nothing is shown to approvers.

## Not in this PR

Enforce (showing the hint to the approver) comes after the data.
