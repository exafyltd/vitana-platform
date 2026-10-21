# VTID-04821 — Jev P3 E1: Exafy company document search, Jev relevance in shadow

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 E1 (P3).

Owner decision 2026-10-01: Drive and OneDrive are always Exafy corporate accounts (d.stevanovic@exafy.io and
j.tadic@exafy.io today); company documentation is always on the Exafy Drive.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `searchCompanyDocs` searches the caller's own connected Google Drive (first) and OneDrive, read-only, and returns names, kinds, dates and links only; a connection counts only when its account email is exactly on `COMPANY_DOCS_DOMAINS` (default `exafy.io`, never a subdomain or look-alike) and its granted scopes cover drive.readonly / Files.Read.All; every provider reports why it was or was not searched, and one failing never hides the other.
  TEST: services/gateway/test/vtid-04821-company-doc-search.test.ts
AC-2: `companyDocsConnectUrl` asks for sign-in identity plus read-only files and keeps the scopes the connection already has; nothing is added to the member Connected Apps catalogue.
  TEST: services/gateway/test/vtid-04821-company-doc-search.test.ts
AC-3: Operator Console tools `dev_company_docs_search` and `dev_company_docs_connect` are declared, dispatched, refuse anyone but a verified exafy_admin on the request, and sit in a router lane (A10 coverage stays complete).
  TEST: services/gateway/test/vtid-04821-company-doc-search.test.ts
  TEST: services/gateway/test/vtid-04816-operator-route.test.ts
AC-4: New decision `company_doc_relevance` (business data, `pii: 'redact'`, internal plane). Gate `company_doc_relevance` (`JEV_COMPANY_DOC_RELEVANCE_MODE`, exact values; anything else off). Off, no tenant or no results asks and writes nothing. In shadow, after a search with results, one `jev_shadow_decisions` row under the caller's tenant (`subject_type = company_doc_search`, hashed subject_ref, the search text never stored); agreement at once with the provider's rank 1; Jev down → fallback row; never throws.
  TEST: services/gateway/test/vtid-04821-company-doc-search.test.ts
AC-5: Both gateways pin `JEV_COMPANY_DOC_RELEVANCE_MODE=shadow`, never enforce; generated pins agree; the prod task-definition steps stay under GitHub's per-step limit; the operator pipeline and role separation suites stay green.
  TEST: services/gateway/test/vtid-04821-company-doc-search.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/company-docs/company-docs.ts (new)
- services/gateway/src/services/company-docs/company-docs-repository.ts (new)
- services/gateway/src/services/jev/gates/company-doc-relevance-gate.ts (new)
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/operator-route-gate.ts (two lane entries)
- services/gateway/src/services/gemini-operator.ts (two tool declarations, one dispatch case, one executor)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04821-company-doc-search.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04821/**

## OASIS

OASIS_IMPACT: none new. Each search with results emits the existing `jev.decision.*` event (source `jev:gate:company_doc_relevance`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_COMPANY_DOC_RELEVANCE_MODE=shadow`. Two new staff-only Operator
Console tools; nothing changes for members.

## Before first use (owner side, not code)

- Google OAuth client: add the `drive.readonly` scope to the consent screen (a restricted scope; an internal or
  test-user app for exafy.io avoids the verification review).
- Microsoft app registration: add the delegated `Files.Read.All` permission.

## Not in this PR

Enforce (listing Jev's pick first); E2 document type routing (VTID-04822).
