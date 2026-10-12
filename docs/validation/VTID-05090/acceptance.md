# VTID-05090 — Partner data processing agreement (AVV) becomes signable on Vitanaland

Health Hub D9 (phase 0L). The `dpa` onboarding step is required for `lab` and `practitioner_clinic`, but nothing could ever complete it: no endpoint, no stored text, no record. This adds the platform side as a sibling of the partner terms flow (VTID-04895/04909): versioned agreement text published by the owner/legal through an exafy_admin API, signing by the supplier's own session on Vitanaland, an append-only signature record, and the checklist deriving `dpa` from that record. Until legal publishes a version the step stays open with `dpa_not_published`. No legal text and no legal conclusion is in code.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/admin/partner-dpa', adminPartnerDpaRouter, { owner: 'admin-partner-dpa' })`; the supplier routes `GET /:orgId/dpa` and `POST /:orgId/dpa/sign` are added to the existing partner-onboarding router (`/api/v1/partner-onboarding`). The commerce domain in `orb/developer/domain-atlas.ts` claims `/^admin-partner-dpa$/` and the table `partner_dpa_versions`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/:orgId/dpa (and `/api/v1/admin/partner-dpa`)

CURL_PROOF: after the staging deploy STAGING-VERIFY runs docs/validation/VTID-05090/staging-tests.json — an anonymous `GET /api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000/dpa?locale=de` and an anonymous `GET /api/v1/admin/partner-dpa` both answer 401 JSON. Read-only: both are unauthenticated GETs rejected before any database read; no POST is probed and nothing is published or signed (staging shares the production Supabase project).

OASIS_PROOF: `partner_org.dpa_signed` (on a new signature only: org id, version, version id, hash, shown_locale, actor_id — no IP, user agent, email, signer name or role), `partner_dpa.draft_saved`, `partner_dpa.version_published` and `partner_dpa.resign_required` — asserted in services/gateway/test/vtid-05090-partner-dpa.test.ts and services/gateway/test/admin-partner-dpa.test.ts; all registered in `CicdEventType` (`src/types/cicd.ts`).

MIGRATION: `supabase/migrations/20261012200000_vtid_05090_partner_dpa.sql` — additive and idempotent, **NOT APPLIED BY MERGING**. Applied only via `RUN-MIGRATION.yml` after the owner's production approval, followed by a read-only check that both tables exist and are empty. Until then every gateway read fails closed (`published:false`, `dpa_not_published`).

## Acceptance criteria

AC-1: Vitanaland can publish exactly one active DPA version through the exafy_admin API (German binding and English required; optional per-language signing declaration; drafts editable, published versions immutable for every role; publishing supersedes the previous version in one transaction; the database computes the hash over the German title, body and signing declaration). Writes need the admin's own session.
  TEST: services/gateway/test/admin-partner-dpa.test.ts
  TEST: scripts/ci/sql-tests/vtid-05090-partner-dpa.test.sql
AC-2: The supplier reads the agreement in force on Vitanaland — one language at a time, German when theirs is missing, Arabic right-to-left, the binding German text, the signing declaration and the version hash — or `published:false, dpa:null` when nothing is published (never an error).
  TEST: services/gateway/test/vtid-05090-partner-dpa.test.ts
AC-3: Signing stores the exact version + hash + language on screen, the signer (user id, account email, typed name and role), the ticked declaration, an org snapshot (legal name, country, VAT id, website), time, IP and user agent; signatures are append-only, one per org and version (second sign is idempotent), and a stale version/hash is refused by the database.
  TEST: services/gateway/test/vtid-05090-partner-dpa.test.ts
  TEST: scripts/ci/sql-tests/vtid-05090-partner-dpa.test.sql
AC-4: An AI assistant can never sign: an OAuth `client_id` claim, a session created for an OAuth client, a token without a session or an unknown session is refused with 403 DPA_SIGNATURE_REQUIRES_SUPPLIER before anything else is read.
  TEST: services/gateway/test/vtid-05090-partner-dpa.test.ts
AC-5: Refusals: 503 DPA_NOT_PUBLISHED, 409 DPA_VERSION_MISMATCH / DPA_CONTENT_MISMATCH, 400 INVALID_SHOWN_LOCALE, 400 INVALID_SIGNATURE, 404 ORG_NOT_FOUND, 409 DPA_NOT_REQUIRED, 409 DPA_COMPANY_INCOMPLETE, 403 ACCOUNT_EMAIL_REQUIRED.
  TEST: services/gateway/test/vtid-05090-partner-dpa.test.ts
AC-6: The checklist derives `dpa` from the signatures: no published version → `todo` with `dpa_not_published`; signed under the current baseline → `done` (a finished lab/clinic goes live); a material update reopens it; a stored `dpa` step row no longer decides it; types without a DPA show `not_required` and read no DPA tables. The DPA reads run on their own before the existing Promise.all and fail closed, never a 500.
  TEST: services/gateway/test/vtid-04478-partner-onboarding-checklist.test.ts
  TEST: services/gateway/test/vtid-04953-checklist-policy.test.ts
  TEST: services/gateway/test/vtid-05090-partner-dpa.test.ts
AC-7: Commerce MCP: while the DPA (or the Partner Terms — sibling fix) is not published, `next_action` says Vitanaland is still preparing it, with no link; once published, the sign/accept action with the portal link.
  TEST: services/gateway/test/vtid-04941-commerce-mcp-automation.test.ts
AC-8: RLS: members read only their own org's signatures; browsers read only published/superseded versions and write nothing; only the service role publishes. The migration is idempotent.
  TEST: scripts/ci/sql-tests/vtid-05090-partner-dpa.test.sql
AC-9: The new route file is claimed by an atlas domain (VTID-04560 drift guard).
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

## Out of scope

The DPA/AVV text and every legal judgement (owner/counsel), advanced/qualified e-signatures, counter-signature, PDF/email copies, termination, moving `REQUIRED_BY_TYPE` to data, an admin screen, erasure handling of signer identity (open question 7), and the vitana-v1 frontend (separate PR).
