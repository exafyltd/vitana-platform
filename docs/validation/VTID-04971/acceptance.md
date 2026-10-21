# VTID-04971 — OpenAI reviewer sandbox: a test-flagged supplier can run the whole MCP flow and reaches no staff, member or go-live surface

Owner decision 2026-10-08 (Gate 1, Decision 1, Option A). Sparring: `plan-sparring.md` (copy of the converged record; reviewer sandbox is a work item of the same plan).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route. Changes behind `POST /mcp` (`submit_for_verification`, `connect_store`, `get_onboarding_status` for a registered test/service owner), `POST /api/v1/partner-onboarding/:orgId/submit`, and `GET /api/v1/admin/partner-review`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp (staging, read-only metadata GET).

CURL_PROOF: staging metadata GET stays 200; an unsigned `POST /mcp` stays 401 (rejected probe, nothing written). The sandbox flow itself needs a sign-in and writes, so it is covered by the jest suite and by the owner's provisioning run, not by an automated staging test.

OASIS_PROOF: a sandbox submit emits `partner_org.sandbox_submitted` (vtid VTID-04971, actor = the supplier) and NO `partner_org.lifecycle_changed`; asserted in services/gateway/test/vtid-04971-review-sandbox.test.ts.

## Acceptance criteria

AC-1: A supplier whose owner is in `service_bot_accounts` or `notification_test_actors` is a sandbox supplier; a lookup error falls back to the normal flow.
  TEST: services/gateway/test/vtid-04971-review-sandbox.test.ts
AC-2: `submit_for_verification` for a sandbox supplier (prerequisites met) records `partner_org.sandbox_submitted`, changes no state (no lifecycle write, so no review-queue entry and no go-live), and the status tells the assistant so (`sandbox`, `sandbox_note`); with prerequisites missing it refuses exactly as before (terms stay a human step).
  TEST: services/gateway/test/vtid-04971-review-sandbox.test.ts
AC-3: `connect_store` for a sandbox supplier recognises the platform but creates no connection and no integration manifest.
  TEST: services/gateway/test/vtid-04971-review-sandbox.test.ts
AC-4: The Command Hub review list leaves sandbox suppliers out and does not expose owner ids.
  TEST: services/gateway/test/vtid-04971-review-sandbox.test.ts
AC-5: The existing review, onboarding and MCP behaviour for real suppliers is unchanged.
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
  TEST: services/gateway/test/vtid-04847-partner-onboarding-service.test.ts
  TEST: services/gateway/test/commerce-mcp.test.ts

## Why a sandbox supplier can never go live or sell (already in the database, VTID-04769)
`supplier_listing_block` returns `excluded_account` for any org or merchant owner in either allowlist, so its products stay inactive (`listing_hold = 'excluded_account'`) even if the org were forced live; checkout rejects inactive items; member RLS shows only active rows.

## Provisioning (owner-run, NOT executed by this change)
`provisioning.sql` in this folder: register both allowlist rows BEFORE the auth user exists (the primary membership is created in the same transaction as the user), create the user with that id, remove its idle live room, run the checks, and the reset block for between reviews.

## Decisions taken (conservative choices inside the approved plan)
- No schema change and no new column: the owner decides (same pattern as the listing gate).
- Submit stops after the prerequisites check; the reviewer still needs the Partner Terms accepted by a person in a direct session (and a published terms version) to see the sandbox outcome. Without it the reviewer sees the prerequisites error with the Vitanaland link, which is also the terms negative test case.
- The review list filter is defence in depth; the admin merchant catalogue list is left unfiltered on purpose so staff can still see the reviewer's draft merchant.
- Gaps recorded, not fixed here: `trg_create_user_live_room` has no exclusion (handled by the provisioning script), `partner_organizations_select` RLS shows any `status = 'active'` org (a sandbox org cannot reach active because submit never changes its state).

## Not in this VTID
Creating the account (owner-run), the plugin package, the review test cases, the OpenAI submission.
