# VTID-04810 — Jev P2 E5: duplicate company/customer detection on CRM creates, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 E5 (P2).

Backoffice entity resolution matches a name only exactly (VTID-03842, "refuse to guess"), so "Acme GmbH", "ACME"
and "Acme Holding GmbH" become three accounts and nothing notices. CRM contacts are personal data: this slice
covers companies only, with business fields only; leads and contacts (people) wait for the DPA.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `account_duplicate` (business data, `pii: 'redact'`, internal plane, backoffice roles): "are these two records the same company", from both accounts' names and business details (industry, domain, lifecycle, customer group, territory).
  TEST: services/gateway/test/vtid-04810-duplicate-account.test.ts
AC-2: Only `crm.company.create` and a `sales.customer.create` whose `customer_type` is Company are checked; existing records that are people (`customer_type` other than Company) are never read into a decision; the record just created is excluded by the id its receipt returns.
  TEST: services/gateway/test/vtid-04810-duplicate-account.test.ts
AC-3: Candidates come from the ERP through the bridge's own read actions (`list-crm-companies` / `list-customers`, the tenant's routing, the requester as actor, channel system) with a name search and one unfiltered retry; similar = equal after removing case, punctuation, accents and legal-form words, or word overlap ≥ 0.5; at most 3, exact first.
  TEST: services/gateway/test/vtid-04810-duplicate-account.test.ts
AC-4: Gate `crm_duplicate_account` (`JEV_CRM_DUPLICATE_ACCOUNT_MODE`, exact values; anything else off). Off reads, asks and writes nothing. In shadow, one `jev_shadow_decisions` row per create (`system_action = created`) with each candidate's verdict; agreement at once against the name rule where it is certain, else null; bridge down → nothing; Jev down → fallback row; never throws.
  TEST: services/gateway/test/vtid-04810-duplicate-account.test.ts
AC-5: Both command paths (direct and approved) run it after the command, never awaited; commands, receipts and responses are unchanged (Backoffice/CRM suites green); both gateways pin `JEV_CRM_DUPLICATE_ACCOUNT_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04810-duplicate-account.test.ts
  TEST: services/gateway/test/vtid-04782-crm-gates.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/duplicate-account-gate.ts (new)
- services/gateway/src/services/backoffice/command-orchestrator.ts (one fire-and-forget call on both paths)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04810-duplicate-account.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04810/**

## OASIS

OASIS_IMPACT: none new. Each judged pair emits the existing `jev.decision.*` event (source `jev:gate:crm_duplicate_account`), at most 3 per create.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_CRM_DUPLICATE_ACCOUNT_MODE=shadow`. Backoffice commands behave exactly as before; the extra ERP reads are list actions only.

## Not in this PR

Enforce (asking the user before a likely duplicate is created) and leads/contacts (after the DPA).
