# VTID-04733 — What's New card automation (gateway half)

`POST /api/v1/scheduled-notifications/whats-new` (daily 16:00 UTC via
EventBridge, `scripts/aws/setup-eventbridge-whats-new.sh`) reads the
PRODUCTION frontend's `/whats-new.json` and publishes at most one new
"Brand New Feature" card + push per run.

AC-1: publishes the oldest fresh unpublished entry tenant-wide and notifies every member in their locale.
TEST: npx jest test/scheduled-notifications-whats-new.test.ts (services/gateway)

AC-2: never publishes an entry twice (id recorded in created_by), never a stale one (>14 days), and at most one per 20 h.
TEST: npx jest test/scheduled-notifications-whats-new.test.ts (services/gateway)

AC-3: the kill switch WHATS_NEW_AUTOPUBLISH=false skips everything; an unreachable manifest or a failed dedupe lookup publishes nothing.
TEST: npx jest test/scheduled-notifications-whats-new.test.ts (services/gateway)

Not run against staging: the route writes a card and pushes to real members
(staging shares the production Supabase project), so per rule 48 it is proven
by the Jest suite above; staging only checks the gateway is alive.

ROUTE_MOUNT: services/gateway/src/index.ts — mountRouterSync(app, '/api/v1/scheduled-notifications', scheduledNotificationsRouter) (already mounted; this PR adds a handler to that router, no new mount)
FINAL_URL: POST https://gateway.vitanaland.com/api/v1/scheduled-notifications/whats-new (staging: preview-aws-gateway.vitanaland.com)
CURL_PROOF: NOT RUN, deliberately. The route publishes a News Feed card and pushes to real members, and staging shares the production Supabase project, so calling it on any live host is forbidden (rule 48; CLAUDE.md absolute no-test-against-production rule). The route is proven instead by test/scheduled-notifications-whats-new.test.ts, which drives the real router over supertest with a fake Supabase. The first live call is the EventBridge schedule after PUBLISH, observable in CloudWatch logs and the notification.whats_new.dispatched OASIS event.

OASIS_PROOF: the route emits exactly one notification.whats_new.dispatched event (vtid VTID-04733, payload entry/announcement_id/dispatched) per published card and none when nothing is published; asserted in test/scheduled-notifications-whats-new.test.ts (mocked emitOasisEvent, so the event is proven emitted, not proven stored).
