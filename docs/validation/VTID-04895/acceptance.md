# VTID-04895 — Partner terms: publish, show, accept, re-accept

`terms_not_published` blocked every supplier from submitting: the version in force was the env var `PARTNER_TERMS_VERSION`, which no deploy sets, and the terms text was stored nowhere. This adds the partner-terms lifecycle (owner decisions 2026-10-05: O-1 live suppliers stay live, re-acceptance is a status/banner only; O-2 API only, no admin screen; O-3 English is binding, German is a displayed translation).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/admin/partner-terms', adminPartnerTermsRouter, { owner: 'admin-partner-terms' })`; the supplier route `GET /:orgId/terms` is added to the existing partner-onboarding router (`/api/v1/partner-onboarding`).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/partner-terms (and `/api/v1/partner-onboarding/:orgId/terms`)

CURL_PROOF: after the staging deploy STAGING-VERIFY runs docs/validation/VTID-04895/staging-tests.json — an unsigned `GET /api/v1/admin/partner-terms` and an unsigned `GET /api/v1/partner-onboarding/<id>/terms` both answer 401 JSON (rejected probes; nothing is read or written).

OASIS_PROOF: `partner_terms.draft_saved` (who created or edited which draft), `partner_terms.version_published` (on every publish: version, id, hash, requires_reacceptance, baseline, superseded id, actor), `partner_terms.reacceptance_required` (a material update after an earlier version: affected org count) and `partner_org.terms_accepted` (now with terms_version_id, content_sha256, shown_locale) — asserted in services/gateway/test/admin-partner-terms.test.ts and services/gateway/test/partner-onboarding.test.ts; all registered in `CicdEventType`.

## Acceptance criteria

AC-1: Vitanaland can publish exactly one active partner-terms version (exafy_admin API; drafts editable, published versions immutable — enforced by the database for every role; publishing supersedes the previous version in one transaction).
  TEST: services/gateway/test/admin-partner-terms.test.ts
  TEST: scripts/ci/sql-tests/vtid-04895-partner-terms.test.sql
AC-2: The supplier sees the current terms inside Vitanaland: the English binding text, with the translation in their language alongside when one exists, the version and its content hash.
  TEST: services/gateway/test/partner-onboarding.test.ts
AC-3: Acceptance is explicit and stores business, user, exact version (string + id), content hash, language shown and timestamp; the hash must equal the published text; acceptances are append-only.
  TEST: services/gateway/test/partner-onboarding.test.ts
  TEST: scripts/ci/sql-tests/vtid-04895-partner-terms.test.sql
AC-4: An AI agent can never accept on the supplier's behalf: a token with an OAuth `client_id` claim, a session created for an OAuth client, or a token whose session cannot be established is refused (403 TERMS_ACCEPTANCE_REQUIRES_SUPPLIER). The publishing API refuses the same.
  TEST: services/gateway/test/partner-onboarding.test.ts
  TEST: services/gateway/test/admin-partner-terms.test.ts
AC-5: Re-acceptance: an editorial update keeps acceptances valid, a material update reopens the terms step for every org that accepted before; live suppliers stay live (no lifecycle change).
  TEST: services/gateway/test/partner-onboarding.test.ts
  TEST: services/gateway/test/vtid-04478-partner-onboarding-checklist.test.ts
  TEST: scripts/ci/sql-tests/vtid-04895-partner-terms.test.sql
AC-6: With the migration not applied or no version published, behaviour is exactly as before (`terms_not_published`), never an error.
  TEST: services/gateway/test/partner-onboarding.test.ts
  TEST: services/gateway/test/admin-partner-terms.test.ts

## Out of scope

Catalogue, verification, billing, the Commerce MCP (its existing "accepted on Vitanaland, give them the link" guidance stays) and any admin screen. No terms text is written here: the owner/legal supplies it through the API.
