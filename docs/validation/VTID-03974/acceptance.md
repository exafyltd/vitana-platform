# Acceptance — VTID-03974: Commerce Partner Onboarding Phase B (partner_registry bridge, health vertical only)

SCOPE_ALLOWLIST: services/gateway/src/routes/partner-orgs.ts, services/gateway/src/routes/admin-partner-health.ts, services/gateway/src/types/cicd.ts, services/gateway/test/partner-orgs.test.ts, services/gateway/test/admin-partner-health.test.ts, supabase/migrations/20260916130000_vtid_03974_commerce_vertical.sql, docs/validation/VTID-03974/**

ACCEPTANCE:

AC-1 registration requires and stores a commerce_vertical (health|general)
TEST: services/gateway/test/partner-orgs.test.ts — "400 when commerce_vertical is missing or invalid" (400 with neither/an invalid value); "201 happy path — general-commerce vertical registers the same way" (a valid value is accepted, stored, and returned).

AC-2 an unset/invalid commerce_vertical is rejected at the API boundary, not silently defaulted
TEST: services/gateway/test/partner-orgs.test.ts — same "400 when commerce_vertical is missing or invalid" test asserts the exact 400 status and error message body.

AC-3 activating a general-commerce org never touches partner_registry
TEST: services/gateway/test/partner-orgs.test.ts — "200 happy path — general-commerce vertical, no partner_registry bridge": deliberately registers NO `partner_registry` fake-table handler, so a stray call to that table throws inside the test itself; also asserts no `partner_org.registry_linked` OASIS event fires.

AC-4 activating a health-vertical org creates a new partner_registry row bridged via partner_organization_id
TEST: services/gateway/test/partner-orgs.test.ts — "200 happy path — health vertical bridges to a NEW partner_registry row (VTID-03974)": asserts a `partner_registry` insert happens and a `partner_org.registry_linked` OASIS event fires carrying the new row's id.

AC-5 the bridge is idempotent — re-activating an already-bridged health org does not insert a second partner_registry row
TEST: services/gateway/test/partner-orgs.test.ts — "200 happy path — re-activating a health org already bridged is a no-op (idempotent)": the fake `partner_registry` handler throws on any `insert` call; test passing proves none happened, and no second `registry_linked` event fires.

AC-6 the bridge is keyed on partner_key = org.org_key, matching the pre-existing partner_registry write shape (portal_manual integration_mode, active status, capabilities all false) rather than inventing a new row shape
CURL: N/A (no live endpoint reachable from this sandbox). Verified by source read: docs/validation/VTID-03974/outputs/partner-orgs-commerce-vertical-grep.txt line 338 onward shows the find-or-create keyed on partner_key, matching this repo's existing DoctorBox-seeded partner_registry rows' shape.

AC-7 a new manual inbox-entry route exists, gated the same way confirm-match already is (requireAuth + requirePartnerHealthAccess org-scoped check), and reuses the existing quarantineUnmatchedResult() write path rather than adding a second one
TEST: services/gateway/test/admin-partner-health.test.ts — "400 when partner_id or raw_payload is missing"; "403 for a professional-only org member (assigned-order-only, not full access)"; "201 happy path for admin — no candidates given, reason=no_match"; "201 happy path for the org's own staff — candidate user ids given, reason=ambiguous_match".

AC-8 no new syntax/type errors introduced by this diff
TEST: standalone tsc --noEmit (sandbox has no node_modules — see commands.log for the full invocation and why). outputs/tsc-check.txt shows only pre-existing module-resolution (TS2307) and one pre-existing Node-builtin typing gap (TS2591, unrelated to this diff), zero new errors.

AC-9 the new commerce_vertical column is file-only (not yet applied to live Supabase), matching this repo's established migration-PR convention
CURL: N/A. Verified by file presence: supabase/migrations/20260916130000_vtid_03974_commerce_vertical.sql exists in this diff and uses `ADD COLUMN IF NOT EXISTS` + a CHECK constraint for safe idempotent application whenever it is applied.

ROUTE_MOUNT: `POST /inbox/manual` is added to the existing `admin-partner-health.ts`
router (`services/gateway/src/routes/admin-partner-health.ts`), the SAME
router that already serves `confirm-match`/`orders`/`inbox` — no new router
file, no new mount call. That router is mounted at
`/api/v1/admin/partner-health` in `services/gateway/src/index.ts:1111`
(`mountRouterSync(app, '/api/v1/admin/partner-health',
adminPartnerHealthRouter, { owner: 'admin-partner-health' })`) — unchanged
by this PR.

FINAL_URL: `POST https://preview-aws-gateway.vitanaland.com/api/v1/admin/partner-health/inbox/manual`
(staging, once this PR merges and `AWS-STAGE-DEPLOY-GATEWAY.yml` auto-deploys).
Not dispatched to production in this PR.

CURL_PROOF: not available from this sandbox (no network path to
`preview-aws-gateway.vitanaland.com`, and `curl gateway.vitanaland.com`
would be a production write-adjacent probe this repo's own rules forbid
running speculatively). After merge-to-main auto-deploys staging, run:
`curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST
https://preview-aws-gateway.vitanaland.com/api/v1/admin/partner-health/inbox/manual
-H "Content-Type: application/json" -d '{}'` — expected `401
application/json` (no `Authorization` header — route exists, auth
required), NOT `404 text/html` (which would mean the route didn't
actually mount). This is the outstanding live-verification step, same
posture as every other unverified-in-sandbox item in this evidence pack.

MERGE_PAYLOAD_PREVIEW:
- ALTER TABLE partner_organizations ADD COLUMN commerce_vertical TEXT CHECK (commerce_vertical IN ('health','general')), nullable, file-only (not applied to live Supabase in this PR).
- POST /api/v1/partner-orgs/register now requires commerce_vertical; POST /:orgId/activate bridges a health-vertical org to a new (or existing) partner_registry row keyed on partner_key = org_key, emitting partner_org.registry_linked.
- New POST /api/v1/admin/partner-health/inbox/manual route (org-scoped auth, reuses quarantineUnmatchedResult()).
- Frontend (exafyltd/vitana-v1, separate PR under this same VTID family): RegisterOrgDialog.tsx gains a commerce_vertical selector (health vs. general), new DE/EN i18n keys.

OASIS_IMPACT: emits partner_org.registry_linked (new CicdEventType) on first health-vertical activation only; no change to existing partner_org.activated emission; no new polling/heartbeat events.
