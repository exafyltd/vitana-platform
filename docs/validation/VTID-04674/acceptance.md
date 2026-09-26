# VTID-04674 — an admin on/off switch per notification type, applied on every send path

Owner instruction (2026-09-26): nothing reaches members, admins or developers unless
the admin has switched that notification on in Admin › Notifications; new
notification types start off; the member's own switches keep working.

Before this change no switch could stop a notification type. `notification_categories.is_active`
only decided whether members could opt out. Rows written by database triggers
(new posts, likes, comments, follows, chat) were pushed by `/push-dispatch`,
which checked only the member's push switch and quiet hours. Reminders pushed
directly, bypassing everything.

## The rule
A notification is sent only if all of these hold:
- the admin switch for its type is ON (and, for an automation's sends, the switch for that automation too);
- the member has not switched off the category the type belongs to;
- for a push, the member's push switch is on and it is outside quiet hours (P0 bypasses quiet hours).

The same rule is applied in two places:
- the database guard: a BEFORE INSERT trigger on `user_notifications`;
- the gateway: `notification-controls-service`.

A type nobody has registered is added as OFF the first time something tries to send it.

## Acceptance criteria
AC-1: a type switched off is not created by any database trigger or gateway insert, and is counted as `admin_off`.
  TEST: docs/validation/VTID-04674/sql-guard-test.sql
  TEST: services/gateway/test/vtid-04674-notification-controls-wiring.test.ts
AC-2: an unknown type is blocked and registered as OFF on its first send.
  TEST: docs/validation/VTID-04674/sql-guard-test.sql
AC-3: an automation's sends need the type switch AND that automation's switch; every automation send carries `automation_id`.
  TEST: docs/validation/VTID-04674/sql-guard-test.sql
  TEST: services/gateway/test/vtid-04674-notification-controls-wiring.test.ts
AC-4: `notifyUser` checks the switch before writing or pushing. A row the guard dropped never gets a push.
  TEST: services/gateway/test/vtid-04674-notification-controls-wiring.test.ts
AC-5: `/push-dispatch` does not push a pending row whose type is switched off.
  TEST: services/gateway/test/vtid-04674-notification-controls-wiring.test.ts
AC-6: a reminder push (`reminder_due`) waits on the full decision: admin switch, member category, push switch, quiet hours.
  TEST: services/gateway/test/vtid-04674-notification-controls.test.ts
  TEST: services/gateway/test/vtid-04674-notification-controls-wiring.test.ts
AC-7: no other code path sends a push directly. A new one fails the build until it is gated.
  TEST: services/gateway/test/vtid-04674-notification-controls-wiring.test.ts
AC-8: the admin API lists every catalog type plus every type seen in the database, with switch, audience, category, per-automation switches and 7-day counts. A count that cannot be read is an error, never 0.
  TEST: services/gateway/test/vtid-04674-notification-controls.test.ts
  TEST: services/gateway/test/routes/admin-notification-controls.test.ts
AC-9: switching writes the row, an audit entry and the OASIS event `notification.control.changed`. Switching ON a type whose text is English only is refused (409); switching it off is always allowed.
  TEST: services/gateway/test/vtid-04674-notification-controls.test.ts
  TEST: services/gateway/test/routes/admin-notification-controls.test.ts
AC-10: access. Tenant admin of that tenant or exafy_admin: allowed. Anyone else: 401/403. The tenant-role lookup reads `SUPABASE_SERVICE_ROLE`, the variable the task definitions set.
  TEST: services/gateway/test/routes/admin-notification-controls.test.ts
AC-11: the old Admin › Notifications API (compose / sent / stats) authenticates before the exafy_admin check; before, every call answered 401.
  TEST: services/gateway/test/routes/admin-notifications.test.ts
  TEST: services/gateway/test/vtid-04674-notification-controls-wiring.test.ts
AC-12: members get "Posts & reactions" and "Tips & updates from Vitana". `new_follower` and `message_reaction` join existing categories. Members see only categories holding an admin-enabled type. A category marked `member_can_disable=false` stays on and refuses to be switched off.
  TEST: docs/validation/VTID-04674/sql-guard-test.sql
  TEST: services/gateway/test/routes/user-category-preferences-vtid-04674.test.ts
AC-13: the migration applies cleanly twice (idempotent).
  TEST: docs/validation/VTID-04674/outputs/sql-guard-test.txt
AC-14: on staging, the new routes are mounted and refuse anonymous callers.
  CURL: docs/validation/VTID-04674/staging-tests.json (run by STAGING-VERIFY after the staging deploy)

## Starting state (needs the owner's approval before the migration is applied)
The database is shared by staging and production, so applying the migration
takes effect in production immediately. The migration switches these ON for
every tenant, because they are the types delivered to members in the 30 days
before this change:
- `community_post_published`, `feature_announcement`, `new_chat_message`
- `post_like`, `post_comment`, `comment_like`, `comment_reply`, `post_mention`
- `new_follower`, `message_reaction`, `memory_garden_grew`, `admin_insight_urgent`
- `reminder_due`

Everything else starts OFF. That includes every scheduled job and every
automation. No automation-sent notification was delivered in those 30 days: no
row carries an `automation_id`.

## Known behaviour changes
- The legacy per-area columns (`community_notifications`, `memory_notifications`, …) are no longer read. Categories decide.
  - Live check, 2026-09-26: 15 preference rows. No member had switched any legacy column off.
  - `memory_notifications=false` on 13 rows was the column default. For those 13, the in-app-only `memory_garden_grew` now appears.
- A switch change reaches other gateway tasks within 30 seconds (cache window).
- If a switch cannot be read, the notification is allowed and the error is logged loudly. The database guard does the same. A read failure must not silence account messages.

## Route evidence
ROUTE_MOUNT: services/gateway/src/index.ts — mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/notification-controls', adminNotificationControlsRouter) (router: routes/admin-notification-controls.ts, Router({ mergeParams: true }), router.use(requireTenantAdmin))
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/tenants/<tenantId>/notification-controls (GET /, GET /activity, GET /:type/audit, PATCH /:type)
CURL_PROOF: before this change, staging `GET /api/v1/admin/tenants/0000…/notification-controls` → `404 text/html` (route absent, curled 2026-09-26); the member route `/api/v1/notifications/category-preferences` → `401 application/json`. After deploy the new route must answer `401 application/json` anonymously — pinned by staging-tests.json and run by STAGING-VERIFY; in-process proof in test/routes/admin-notification-controls.test.ts (401/403/200 through the real requireTenantAdmin).

## OASIS
OASIS_PROOF: every switch emits `notification.control.changed` (vtid VTID-04674, payload tenant_id/type/source_key/old_enabled/new_enabled/reason, actor id + email) — asserted in test/vtid-04674-notification-controls.test.ts ("switching on writes the row, the audit entry and the OASIS event"). The block counters are not OASIS events on purpose (a per-notification count is telemetry, CLAUDE.md §6).
