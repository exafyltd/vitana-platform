# VTID-04677 — /api/v1/scheduled-notifications/* requires the internal token

Every POST under `/api/v1/scheduled-notifications/*` (17 routes) sends
notifications, often a push to every member of a tenant, and accepted
anonymous requests from the public internet. The routes relied on GCP IAM at
the Cloud Scheduler layer; GCP is gone.

Plan sparred and approved: `plan-sparring.md` (2 rounds, converged; owner
approval in session 2026-10-05).

## Rule
A call runs only if it carries `X-Gateway-Internal: <GATEWAY_INTERNAL_TOKEN>`
(timing-safe compare). There is no admin-JWT path: no human calls these routes.
`GET /health` stays open. Rollout switch `SCHEDULED_NOTIFICATIONS_AUTH_MODE`:
`log` (default) lets a call without a valid token through and logs it (never
the header value); `enforce` rejects it (401 missing, 403 wrong, 503 when the
gateway has no token); `off` skips the check.

## Acceptance criteria
AC-1: in enforce mode a call without the token gets 401, a wrong token 403, no token configured 503, and the route never runs; the right token runs it.
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts
AC-2: in log mode (the default) every call still runs; a call without a valid token is logged with method, path, IP and user-agent, and the header value is never logged.
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts
AC-3: an admin bearer token is not accepted; only the internal token is.
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts
AC-4: GET /health stays open in every mode and reports `auth_mode` and `internal_token_configured` (boolean only).
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts
  TEST: docs/validation/VTID-04677/staging-tests.json
AC-5: the middleware is registered before the first route, and no route is still marked `// public-route` or "protected by GCP IAM".
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts
AC-6: the gateway's five own calls (morning-briefing, weekly-digest, diary-reminder, weekly-reflection, upcoming-events) send the token.
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts
AC-7: the three dedicated scheduler Lambdas (push-dispatch, daily-feature-tip, whats-new) read the token from `vitana/gateway/prod/internal-token`, cache it 5 minutes, send it, and still send the call (logging the error) if the secret cannot be read; each exec role may read exactly that secret.
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts
AC-8: the shared cron Lambda lets a job name its token secret; the scheduled-notifications jobs use the production secret; `gateway-daily-feature-tip` is no longer duplicated in it (30 jobs).
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts
  TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts
AC-9: the production deploy wires `GATEWAY_INTERNAL_TOKEN` in every deploy mode and sets no auth mode; staging strips any set mode (so it runs the code default `log`; the step is at the 20,000-char run limit, so it is not pinned) and prints the secret lookup error instead of discarding it.
  TEST: services/gateway/test/vtid-04677-scheduled-notifications-auth.test.ts

## Route evidence
ROUTE_MOUNT: services/gateway/src/index.ts:1135 — mountRouterSync(app, '/api/v1/scheduled-notifications', scheduledNotificationsRouter) (unchanged); this change adds `router.use(requireScheduledNotificationsAuth)` at the top of routes/scheduled-notifications.ts — no new route.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/scheduled-notifications/health (GET, stays open) and the 17 POST routes under the same prefix.
CURL_PROOF: before this change (2026-10-05) `GET https://preview-aws-gateway.vitanaland.com/api/v1/scheduled-notifications/health` → `200 application/json` `{"ok":true,"service":"scheduled-notifications","status":"ok",…}` (no auth_mode); after deploy the same GET must report `"auth_mode":"log"` — pinned by staging-tests.json and run by STAGING-VERIFY. No POST is sent on staging (it would dispatch against the shared production database).

## OASIS
OASIS_PROOF: no new state transition; the middleware only checks a header. A would-be rejection is a log line, not an OASIS event (it fires on every unauthenticated scheduler tick — telemetry, CLAUDE.md §6).

## Rollout (owner steps)
1. Merge → staging (log mode). 2. PUBLISH to production (log mode, token wired).
3. In CloudShell, after production runs this commit — re-run ONLY these three:
   `scripts/aws/setup-eventbridge-push-dispatch.sh`, `scripts/aws/setup-eventbridge-daily-feature-tip.sh`,
   `scripts/aws/setup-eventbridge-whats-new.sh`.
   Do NOT run `setup-eventbridge-cron-migration.sh --only gateway-`: its reminders, daily-pace and
   night-push schedules have never existed in AWS (reminders run in-process, VTID-04320), and creating
   them would start new hourly member notifications.
4. 24 h with no would-be-rejection log lines after step 3. 5. Enforce: a separate change, staging first.

## Known gaps
- Five routes have no known caller (recommendation-cleanup, signal-cleanup, recommendation-expiry,
  weekly-summary, meetup-reminders); silence on them in log mode proves nothing.
- The staging deploy reports the staging token secret as absent although it exists (created 2026-09-26);
  this change prints the real error so the missing permission can be granted precisely.
- Retrofitting timing-safe compare into the other X-Gateway-Internal checks is a follow-up.
- The ledger write recording the sparring on VTID-04677's metadata timed out twice from the session's
  database tool; this file is the record.
