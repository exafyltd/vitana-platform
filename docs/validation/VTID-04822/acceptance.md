# VTID-04822 — Jev P3 E2: document type routing for Exafy company documents, shadow

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 E2 (P3). Builds on E1 (VTID-04821): the company documents it finds on the
Exafy Drive / OneDrive arrive untyped, and the type decides where a document goes next.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `document_type` (business data, `pii: 'redact'`, internal plane): one choice over contract, invoice, quote_or_order, policy, specification, presentation, report, legal_corporate, hr, marketing, other — from name, kind and source only; every type maps to a route (contract → clause_review, invoice → payment_match, policy/specification → knowledge_base, …).
  TEST: services/gateway/test/vtid-04822-document-type-routing.test.ts
AC-2: The rule `ruleDocType` types a file name by keywords in English, German (compounds included) and Serbian, invoices and quotes before contracts; a name it cannot type stays open (null).
  TEST: services/gateway/test/vtid-04822-document-type-routing.test.ts
AC-3: Gate `document_type_routing` (`JEV_DOCUMENT_TYPE_ROUTING_MODE`, exact values; anything else off). Off, no tenant or no documents asks and writes nothing. In shadow, after a company document search with results: the top three non-folder documents, each at most once in 30 days, one `jev_shadow_decisions` row each (`subject_type = company_document`, `subject_ref = provider:id`, `system_action = rule_<type>|rule_none`); agreement at once where the rule names a type, open otherwise; Jev down → fallback row; never throws.
  TEST: services/gateway/test/vtid-04822-document-type-routing.test.ts
AC-4: Wired after the search next to E1's relevance check, never awaited; both gateways pin `JEV_DOCUMENT_TYPE_ROUTING_MODE=shadow`, never enforce; generated pins agree; prod task-definition steps stay under GitHub's 20,000-char limit (19,951 / 19,964); operator pipeline and role separation suites green.
  TEST: services/gateway/test/vtid-04822-document-type-routing.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/document-type-gate.ts (new)
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/gemini-operator.ts (one fire-and-forget call in executeCompanyDocsTool)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04822-document-type-routing.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04822/**

## OASIS

OASIS_IMPACT: none new. Each typed document emits the existing `jev.decision.*` event (source `jev:gate:document_type_routing`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_DOCUMENT_TYPE_ROUTING_MODE=shadow`. The company document search
returns exactly what it did; nothing changes for members.

## Not in this PR

Enforce (routing a document to clause review, payment match or the knowledge base); E9 and E11 themselves.
