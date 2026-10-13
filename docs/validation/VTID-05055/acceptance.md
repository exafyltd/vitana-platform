# VTID-05055 — acceptance criteria (Health Hub Phase 0 / D8, gateway half)

Member-confirmed partner links, audited staff reads, no silent `partner_key` fallback. Every criterion is proven by Jest in `services/gateway`; nothing in this change is exercised by a write on staging (staging shares the production database).

AC-1 `POST /api/v1/admin/partner-health/inbox/:id/confirm-match` no longer inserts into `partner_customer_links` or `partner_health_test_orders`. It writes the proposal (`member_link_status='pending_member'`, `proposed_*` columns) with a compare-and-set from NULL/declined, notifies the member through `notifyUserAsync(…, 'partner_link_request', { title: tt(…), body: tt(…) })`, emits `health_test.link_proposed` and answers `202 { ok, status: 'pending_member', inbox_id }`.
TEST: npx jest test/admin-partner-health.test.ts -t "member proposal"

AC-2 confirm-match answers 400 `USER_NOT_IN_TENANT` when the named user is not in the named tenant, 409 `PENDING_MEMBER` when the row already waits for a member (or the compare-and-set updates nothing), 409 `MEMBER_DECLINED` when that member already declined, and 403 for a professional-only org member.
TEST: npx jest test/admin-partner-health.test.ts -t "member proposal"

AC-3 Without the migration, confirm-match answers 503 `MEMBER_CONFIRMATION_UNAVAILABLE` and never falls back to the old direct link (no link/order query at all); the member GET answers `{ ok: true, requests: [] }`; member confirm/decline answer 503; `GET /inbox` retries with the legacy column list.
TEST: npx jest test/admin-partner-health.test.ts test/partner-health-member.test.ts test/partner-health/link-confirmation.test.ts -t "503|migration|legacy column"

AC-4 Member routes (`/api/v1/partner-health/member/link-requests`, `…/:id/confirm`, `…/:id/decline`) require a user token, filter by `identity.user_id` only (never the session tenant), return only `{ id, partner_display_name, test_name, proposed_at }` and never `proposed_by_admin_id`, `resolved_by_admin_id`, `candidate_user_ids` or `raw_payload`. Another member's row is a 404 (no existence leak).
TEST: npx jest test/partner-health-member.test.ts -t "auth|GET /link-requests|404"

AC-5 The member's confirm creates the link and the order only through `fn_confirm_partner_link_request` (one transaction: row lock, `user_tenants` re-check on the stored `proposed_tenant_id`, link + order with exactly the values confirm-match used to write, resolution). `not_pending`/`not_in_tenant` → 409; an RPC error leaves the row `pending_member` and a retry succeeds; success emits `health_test.order_created` with `actor_id` = the member and `confirmed_by: 'member'`. A member whose session is in tenant B confirms a request proposed in tenant A.
TEST: npx jest test/partner-health/link-confirmation.test.ts test/partner-health-member.test.ts -t "materializeMemberConfirmedLink|POST /link-requests/:id/confirm"

AC-6 Decline compare-and-sets `pending_member → declined`, appends the member to `member_declined_user_ids`, leaves the row unresolved (it stays in the staff inbox) and emits `health_test.link_declined` (`actor_id` = member).
TEST: npx jest test/partner-health-member.test.ts test/partner-health/link-confirmation.test.ts -t "decline"

AC-7 `GET /orders`, `GET /inbox` and `GET /candidates/:inboxId` emit `health_test.staff_read` (route, access scope, partner ids, row count, subject user ids, order/inbox ids, status filter — no `raw_payload`, test names or results) before answering, and answer 503 `AUDIT_UNAVAILABLE` (no data) when the emit returns `ok:false` or throws. 401/403 paths emit nothing.
TEST: npx jest test/admin-partner-health.test.ts -t "audited staff reads"

AC-8 `upload-result` takes `partner_key` from the order's `partner_registry` row. A body `partner_key` is ignored (a mismatch logs a warning and emits `health_test.partner_key_mismatch` with `partner_key_mismatch: true`); a missing registry join is 500 `PARTNER_NOT_REGISTERED` (no `'doctorbox'` default); a `portal_manual` partner without an adapter uses the explicitly named `vitana_manual_json_v1` format, recorded on the result (`raw_payload._upload_format`) and in the response; any other partner without an adapter is 400 `NO_ADAPTER`.
TEST: npx jest test/admin-partner-health.test.ts -t "partner_key from the order|upload-result"

AC-9 The migration is additive only (nullable columns, the `member_link_status` CHECK, the pending-member partial index, the function with `SECURITY DEFINER` + `SET search_path = public`, EXECUTE revoked from PUBLIC/anon/authenticated and granted to service_role only) and switches `partner_link_request` on with exactly the VTID-04926 seed shape. The gateway's notification config, admin catalog, OASIS event union and the `notif.partner_link_request.*` keys (10 translated locales; DE du-form; `ar` stays empty by the catalog-coverage rule) agree with it.
TEST: npx jest test/vtid-05055-member-link-migration.test.ts test/partner-health/link-confirmation.test.ts test/i18n/catalog-coverage.test.ts -t "migration|registries|catalog"

AC-10 No regression: the role-separation suite (domain-atlas drift guard claims `partner-health-member`), the partner-health/connector/i18n/notification suites, the customer-support pipeline suite, and the gateway type-checks (only TS2742 portability errors from the worktree's symlinked `node_modules`).
TEST: npx jest test/vtid-04560-role-separation-regression.test.ts test/partner-health-consent.test.ts test/partner-health test/connectors test/i18n/catalog-coverage.test.ts test/vtid-04674-notification-controls.test.ts test/vtid-04456-customer-support-pipeline-regression.test.ts; npx tsc --noEmit -p .

ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/partner-health/member', partnerHealthMemberRouter, { owner: 'partner-health-member' })`, exactly once (asserted by `test/partner-health-member.test.ts` "route mount"), router `services/gateway/src/routes/partner-health-member.ts` (`GET /link-requests`, `POST /link-requests/:id/confirm`, `POST /link-requests/:id/decline`, all `requireAuthWithTenant`). The route file is claimed by the `health` domain in `orb/developer/domain-atlas.ts`.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/partner-health/member/link-requests
CURL_PROOF: read-only, after the staging deploy: `curl -s -o /dev/null -w '%{http_code} %{content_type}' https://preview-aws-gateway.vitanaland.com/api/v1/partner-health/member/link-requests` with NO Authorization header must answer `401 application/json` (JSON `UNAUTHENTICATED` from `requireAuthWithTenant`, not an HTML 404), which proves the router is mounted on the deployed commit. STAGING-VERIFY runs exactly this probe from `staging-tests.json`, plus the same anonymous GET against `/api/v1/admin/partner-health/{orders,inbox,candidates/<zero-uuid>}`. No POST and no authenticated request is sent: confirm/decline/propose write to the database staging shares with production, and an authorized staff read writes an audit row to production `oasis_events`. The in-process equivalent of every write path runs in Jest.
TEST: npx jest test/partner-health-member.test.ts -t "auth|route mount"

OASIS_PROOF: new event types in `services/gateway/src/types/cicd.ts` — `health_test.staff_read` (asserted in `test/admin-partner-health.test.ts` "audited staff reads"), `health_test.link_proposed` (`test/admin-partner-health.test.ts` "member proposal"), `health_test.link_declined` (`test/partner-health-member.test.ts` "decline"), `health_test.partner_key_mismatch` (`test/admin-partner-health.test.ts` "partner_key from the order"); the existing `health_test.order_created` is now emitted on the member's confirm with `actor_id` = member (`test/partner-health/link-confirmation.test.ts`, `test/partner-health-member.test.ts`). All carry `vtid: 'VTID-05055'`; union membership is asserted in `test/vtid-05055-member-link-migration.test.ts`. `health_test.*` is not on the timeline projector's allowlist, so none of these reach a member timeline.
TEST: npx jest test/admin-partner-health.test.ts test/partner-health-member.test.ts test/partner-health/link-confirmation.test.ts test/vtid-05055-member-link-migration.test.ts
