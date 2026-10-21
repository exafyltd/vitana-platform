# VTID-04933 — Commerce supplier review v1

Owner decisions 2026-10-07: B1 (admin review flow) with option 1 (per-offering keep offline), B2 (for v1 an admin
approval counts as verification level 1). Nothing is deployed to production by this change, and no production data is
changed: applying "keep offline" to an existing offering is a separate, owner-approved step after a production deploy.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: /api/v1/admin/partner-review (services/gateway/src/index.ts, owner admin-partner-review); Command Hub page /command-hub/partner-review.html (static).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/partner-review (staging, read-only)

CURL_PROOF: after the merge's staging deploy, an unsigned GET of /api/v1/admin/partner-review returns 401 JSON, an unsigned POST to /approve is rejected with 401 before any handler runs, and /command-hub/partner-review.html is served (STAGING-VERIFY, docs/validation/VTID-04933/staging-tests.json).

OASIS_PROOF: new topics partner_org.review.approved, partner_org.review.changes_requested, partner_org.review.rejected, partner_org.review.product_kept_offline, partner_org.review.product_listing_allowed (registered in src/types/cicd.ts), plus the existing partner_org.lifecycle_changed for every lifecycle move; asserted in the Jest suite.

## Acceptance criteria

AC-1: Every /api/v1/admin/partner-review route needs a signed-in exafy_admin (401 unsigned, 403 non-admin), and every write also refuses an assistant's delegated OAuth token (403 REQUIRES_OWN_SESSION); the terms admin routes use the same shared middleware.
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-2: The list shows organizations in verifying, needs_action and exception (or the ?state= filter) with their open required steps and offering count; the detail shows company facts, checklist, offerings with their listing state, terms acceptance and recent partner_org events, without the owner's user id.
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-3: Approve records the verification step as done by admin approval (level 1, approver, time, note, facts snapshot), raises trust_level to at least 1, and moves the organization through the lifecycle graph: live when every required step is done, otherwise needs_action with the open steps listed. Labs and clinics (level 2) are refused.
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-4: Request changes needs a reason, stores it on the verification step, voids an earlier approval (step todo, trust_level 0) and moves the organization to needs_action; reject needs a reason and moves verifying, needs_action or exception to rejected in one move (graph extended with needs_action → rejected).
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-5: The automatic verification check does not downgrade an unexpired admin approval; changed company facts still void it.
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-6: The legacy activate route filters on lifecycle_state and refuses draft, submitted and rejected organizations (409 ORG_NOT_ACTIVATABLE naming the lifecycle state).
  TEST: services/gateway/test/partner-orgs.test.ts
AC-7: Keep offline switches an organization's own offering off with a required reason and keeps it off when the organization goes live, pauses or resumes; allow listing lists it at once for a live organization, otherwise holds it until go-live; another organization's offering is refused. A supplier edit can neither set nor erase the admin's listing note.
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-8: Against the real VTID-04769 go-live triggers on a throwaway Postgres, a kept-offline draft stays off at go-live, a waiting draft goes on, an early-allowed offering is held and goes on with the organization, and a kept-offline offering stays off through pause and resume.
  TEST: scripts/ci/sql-tests/vtid-04933-keep-offline.test.sql
AC-9: The supplier sees the reviewer's request: the verification step returned by get_onboarding_status carries review_note and approved_by_vitanaland.
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-10: On staging after merge, the admin API is mounted behind auth and the Command Hub review page is served.
  CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/admin/partner-review
