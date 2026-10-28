# VTID-05042 — Track S / S3 PR1: tenant admins lose cross-tenant reads (partner-health, oasis_events, global community, media moderation)

Owner approval 2026-10-10 (Gate 1: "Yes approved"). Sparring: `plan-sparring.md` (converged, 3 rounds). Scope: plan §6 PR1 only (S-L + S-F). Migrations and the gateway membership check are VTID-05043.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: unchanged mounts — `/api/v1/admin/partner-health` (admin-partner-health.ts) and `/api/v1/admin/tenants/:tenantId/{audit,overview,community,content}` (routes/tenant-admin/*). New middleware `requirePlatformScope` (middleware/require-tenant-admin.ts) runs after `requireTenantAdmin` on the platform-only routes.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/partner-health/orders (staging).

CURL_PROOF: anonymous GETs answer 401 application/json on partner-health, audit/access, overview/activity, community/live-rooms, content/items; invalid-bearer POST approve / DELETE meetup answer 401 (staging-tests.json). A tenant admin of a real tenant cannot be exercised on staging without a write, so the 403s are proven in jest.

OASIS_PROOF: none — no event is added or removed; a 403 is not a state transition.

## Acceptance criteria

AC-1 (S-L): A Vitana tenant admin (`user_tenants.active_role='admin'`, not exafy_admin, no partner-org membership) gets 403 FORBIDDEN on all seven partner-health routes (GET /orders, PATCH /orders/:id, GET /inbox, GET /candidates/:inboxId, POST /inbox/:id/upload-result, POST /inbox/manual, POST /inbox/:id/confirm-match); no order/inbox/registry/customer-link table is read or written and no ingestion function is called. exafy_admin keeps the unfiltered admin scope; partner-org staff/professional scope is unchanged.
  TEST: services/gateway/test/admin-partner-health.test.ts ("VTID-05042 — tenant admin has no partner-health access", 8 tests)
  CURL: staging GET /api/v1/admin/partner-health/orders anonymous -> 401 application/json

AC-2 (S-F1): GET /audit/access (oasis_events, no tenant column) answers 403 PLATFORM_SCOPE_ONLY to a tenant admin of their own tenant with no query issued; exafy_admin → 200. GET /audit/actions unchanged for the tenant admin (tenant-filtered).
  TEST: services/gateway/test/routes/tenant-admin/audit-log.test.ts
  CURL: staging GET /api/v1/admin/tenants/<id>/audit/access anonymous -> 401 application/json

AC-3 (S-F2): GET /overview/activity and /overview/alerts answer 403 PLATFORM_SCOPE_ONLY to a tenant admin, no query issued; exafy_admin → 200 (existing activity filter and VTID-03787 diag exclusion still asserted). /summary and /at-risk unchanged.
  TEST: services/gateway/test/routes/tenant-admin/overview.test.ts
  CURL: staging GET /api/v1/admin/tenants/<id>/overview/activity anonymous -> 401 application/json

AC-4 (S-F3): /community/live-rooms and /community/memberships are filtered `.eq('tenant_id', :tenantId)` for the tenant admin and for exafy_admin. /meetups GET + DELETE, /groups, /creators, /stats answer 403 PLATFORM_SCOPE_ONLY to a tenant admin with no query and no delete issued; exafy_admin → 200.
  TEST: services/gateway/test/routes/tenant-admin/community-admin.test.ts
  CURL: staging GET /api/v1/admin/tenants/<id>/community/live-rooms anonymous -> 401 application/json
  CURL: staging DELETE /api/v1/admin/tenants/<id>/community/meetups/<id> invalid bearer -> 401 application/json

AC-5 (S-F4): All six /content/items* routes (list, stats, detail, approve, reject, flag) answer 403 PLATFORM_SCOPE_ONLY to a tenant admin; no media_uploads query or update is issued; exafy_admin → 200.
  TEST: services/gateway/test/routes/tenant-admin/content-moderation.test.ts
  CURL: staging POST /api/v1/admin/tenants/<id>/content/items/<id>/approve invalid bearer -> 401 application/json

AC-6: `requirePlatformScope` passes exafy_admin, returns 403 PLATFORM_SCOPE_ONLY (handler never runs) to a tenant admin, and a non-admin member is still stopped earlier by requireTenantAdmin (403 FORBIDDEN).
  TEST: services/gateway/test/middleware/require-tenant-admin.test.ts ("requirePlatformScope (VTID-05042)")

AC-7: The new tests fail against the pre-fix route code (mutation check) and the shared suites stay green.
  TEST: outputs/mutation-src-reverted.txt (25 failed with the six source files reverted to origin/main)
  TEST: outputs/regression-suites.txt (test:roles 105/105, test:support 87/87, test:operator 38/38)

## Contract changes (existing tests rewritten on purpose)
Existing tests that asserted a tenant admin gets 200 on routes that are now platform-only were switched to the exafy_admin identity (same assertions) and a tenant-admin → 403 PLATFORM_SCOPE_ONLY test was added next to them:
- audit-log.test.ts: "GET /access returns auth-topic OASIS events …" (title now "for exafy_admin"), "GET /access returns 500 when the events query fails".
- overview.test.ts: three /activity tests, two /alerts tests.
- community-admin.test.ts: four /meetups tests, two DELETE /meetups/:id tests, two /groups tests, /creators, two /stats tests.
- content-moderation.test.ts: all eleven /items* happy/error-path tests.
