# VTID-04421 — Conversation rebuild WS-2.4: one row per suggestion (`conversation_offer_outcomes`)

This is Plan v1 (Conversation Intelligence Rebuild), Phase 2, workstream WS-2.4.
It ships in PR #3614 as a companion to VTID-04339.

## Why

WS-0.5 (VTID-04355) records every offer's lifecycle as `conversation.offer.{made,accepted,declined,ignored}` events in `oasis_events`. That stream has two problems for the next steps:

- **It cannot say which outcome a given offer finally had.**
- **Reading it means scanning `oasis_events`**, which has no usable `created_at` index (VTID-03980).

WS-2.2 (relevance scoring) needs per-user, per-provider acceptance rates, and the Command Hub needs an outcomes view. Both now read a small indexed table.

## Change

- **Migration `20260923190000_vtid_04421_conversation_offer_outcomes.sql`**, applied to the live project 2026-09-23. It is additive and the table was empty at apply.
  - **`conversation_offer_outcomes`**: one row per `offer_id`, with provider, key, tool, `offered_at` and outcome.
  - **Access**: RLS on, no policies, `anon`/`authenticated` revoked (verified: `authenticated` has no SELECT).
  - **`conversation_offer_outcome_stats(p_since, p_ignored_after, p_user_id)`**: per-provider counts, service role only. An offer still `made` after a day counts as ignored, because it expired unanswered.
- **`offer-outcomes.ts`**:
  - **`buildOfferOutcomeWrite`** (pure): `made` becomes an idempotent insert; the first accepted/declined/ignored settles the row (`WHERE outcome = 'made'`).
  - **`applyOfferOutcomeWrite`** never throws.
  - **The default emitter writes the row next to the unchanged OASIS event**, fire-and-forget; the conversation never waits on it. Legacy offers without an `offer_id` are not tracked.
- **`offer-outcome-stats.ts`**: `readOfferOutcomeStats` (window 1 to 90 days) and the acceptance rate, computed over settled offers only.
- **`GET /api/v1/admin/conversation/offer-outcomes?days=&user_id=`**: exafy_admin only, UUID-validated.
- **Command Hub › Conversation › Monitor**: a new Suggestion outcomes section, with a window of 1, 7 or 30 days.
  - Tiles: made, acceptance, declined, ignored, still open.
  - A per-provider table.

ROUTE_MOUNT: see `docs/validation/VTID-04339/acceptance.md`, "Added by VTID-04421", which covers the same `conversation-hub` router.

## Acceptance criteria

AC-1: `made` inserts one row with the provider, key and tool. Each outcome settles it with its reason. A legacy offer without an id is not tracked.
TEST: services/gateway/test/services/conversation/vtid-04421-offer-outcomes-table.test.ts

AC-2: The insert is idempotent on `offer_id`, only a row still at `made` is settled (the first outcome wins), and a storage error is reported rather than thrown.
TEST: services/gateway/test/services/conversation/vtid-04421-offer-outcomes-table.test.ts

AC-3: Stats read through the service-role function with a bounded window, and the acceptance rate counts settled offers only.
TEST: services/gateway/test/services/conversation/vtid-04421-offer-outcomes-table.test.ts

AC-4: The table and function are service-role only, the endpoint is admin-only, and the Monitor section is mounted.
TEST: services/gateway/test/services/conversation/vtid-04421-offer-outcomes-table.test.ts

AC-5: The section renders at 1400×900 and 390×844 with no page overflow.
TEST: docs/validation/VTID-04421/outputs/shoot-report.json

Screenshots: `outputs/monitor-offers-*.png`. The "Could not load" box above the section is the harness stubbing the older metrics endpoint with empty data; it is unrelated to this change.

CURL (post-deploy, anonymous): `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/offer-outcomes` should return `401 application/json`.

## Not verified live

- **The first real rows appear only once this code runs on staging** and a real offer is made. Staging ECS could not place tasks at the time of writing.
- **The signals to watch for:**
  - `conversation_offer_outcomes` rows whose `offer_id` matches a `conversation.offer.made` event;
  - the Monitor section showing them.
