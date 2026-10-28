# VTID-04782 — Jev P1 E3 + E6: CRM lead score and account classification on create, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 E3, E6. Builds on VTID-04754 (shadow framework, per-tenant control).

Evidence (plan §10.4 E): 0 erp_commands, 0 capability grants and 0 partner orgs in prod, so these gates
will see little traffic until Backoffice is in use. They are wired now so the first real CRM records are
measured from day one. CRM contacts are personal data: business fields only; names of people wait for the DPA.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: A created lead (`crm.lead.create`) sends Jev `lead_score` its business fields only — company name, industry, territory, source, job title. The person's name, email, phone, mobile, LinkedIn and free-text notes are never sent; a lead with no business field is not scored.
  TEST: services/gateway/test/vtid-04782-crm-gates.test.ts
AC-2: A created CRM company (`crm.company.create`) or a customer that is explicitly a company (`sales.customer.create`, `customer_type: Company`) is sent to `account_classification` with its name and business notes. A customer that is an individual, or has no type, is never sent.
  TEST: services/gateway/test/vtid-04782-crm-gates.test.ts
AC-3: Gates `crm_lead_score` and `crm_account_classification` (`JEV_CRM_LEAD_SCORE_MODE`, `JEV_CRM_ACCOUNT_CLASSIFICATION_MODE`, exact values; anything else off) each have their own mode. Off asks and writes nothing; shadow writes one `jev_shadow_decisions` row per record, for the command's tenant (per-tenant flag and budget apply), as a system caller on the internal plane. A command that did not execute is never scored; a throwing call never throws.
  TEST: services/gateway/test/vtid-04782-crm-gates.test.ts
AC-4: Outcomes. E3: when the lead is converted (`crm.lead.convert`), its row gets `lead_converted` and agreed = Jev scored "Good fit" or better. E6: where the create says the kind (a sales customer; a CRM company with a lifecycle), agreement is written at once; otherwise agreed stays null.
  TEST: services/gateway/test/vtid-04782-crm-gates.test.ts
AC-5: The gates run from both execute paths of the command orchestrator (direct, and after an approval), next to the customer-memory write, never awaited; the command, its receipt and response are unchanged.
  TEST: services/gateway/test/vtid-04782-crm-gates.test.ts
  TEST: services/gateway/test/vtid-04411-orchestrator-customer-memory.test.ts
  TEST: services/gateway/test/vtid-03848-orchestrator-voice-ceiling.test.ts
AC-6: Both gateways pin both modes to `shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04782-crm-gates.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/crm-gates.ts (new)
- services/gateway/src/services/backoffice/command-orchestrator.ts (fire-and-forget hook after execute)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pins)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04782-crm-gates.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04782/**

The decisions `lead_score` and `account_classification` already exist (VTID-04473); nothing about them changes.

## OASIS

OASIS_IMPACT: none new. Each check emits the existing `jev.decision.*` event (sources `jev:gate:crm_lead_score`, `jev:gate:crm_account_classification`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with both modes `shadow`. Backoffice commands behave exactly as before.

## Not in this PR

Enforce (e.g. routing a lead by score, flagging a mis-filed account) is P2, after the agreement rate is known.
