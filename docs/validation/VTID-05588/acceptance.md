# VTID-05588 — Acceptance (companion-test-card / gateway-test-card)

Scope of this PR: `POST /api/v1/companion/test-card` (route in `services/gateway/src/routes/companion.ts`, logic in
`services/gateway/src/services/companion/test-card.ts`), the OASIS event type `companion.test_card.sent`, the Jest suite
and this validation folder. No migration. MERGE_PAYLOAD_PREVIEW: the gateway gains one admin-only route; on staging it
answers 409 (companion is disabled there).

AC-1 — Without a sign-in the route answers 401; a signed-in member who is not an exafy admin gets 403; nothing is written.
  TEST: test/companion-test-card.test.ts "401 without a token", "403 for a member who is not an exafy admin".

AC-2 — The body is strict: only `moment_key: "vitana_index"`; any other key (e.g. `user_id`, `receiver_id`) or value is 400.
  TEST: "400 for an unknown moment_key, or any user id in the body (strict)".

AC-3 — Staging answers 409 STAGING_DISABLED; `off` and `shadow` answer 409 SEND_NOT_AVAILABLE; `staff` and `live` send.
  TEST: "409 STAGING_DISABLED on staging", "409 SEND_NOT_AVAILABLE when the mode is off|shadow", "works in staff mode too".

AC-4 — No Vitana Index → 422 NO_VITANA_INDEX without composing or writing; a failed composition → 502 COMPOSE_FAILED without writing; no client → 503.
  TEST: "422 NO_VITANA_INDEX …", "502 COMPOSE_FAILED …", "503 when no service-role client is configured".

AC-5 — Success writes exactly one `chat_messages` row from the Vitana bot to the caller, whose metadata equals a tick message's `buildCompanionMetadata` output for the same moment plus `test: true` (F2 card, numeric params only); the composer receives the caller's context and the real `vitana_index` moment.
  TEST: "sends exactly one Vitana-bot DM to the caller with the tick card metadata plus test: true".

AC-6 — No ledger access, no pacer touch, no push, no `companion.message.sent`; exactly one `companion.test_card.sent` event.
  TEST: same test (ledger table never touched, recordTouch and notifyUser not called, emitted types = [companion.test_card.sent]).

AC-7 — A second press within 60 s answers 429 RATE_LIMITED with `retry_after_s`; a refused or failed call does not consume the minute.
  TEST: "429 RATE_LIMITED for a second press inside 60 s", "a refused or failed press does not use up the minute".

AC-8 — The suite fails on base.
  TEST: red-on-base.txt (13 failed on 2b9356e041).

Not claimed here: a real send on a deployed gateway. Staging answers 409 by design (shared production database, CLAUDE.md
rule 48); production is reached only after Gate 2 and the owner's publish.

ROUTE_MOUNT: services/gateway/src/index.ts:176 (`const companionRouter = require('./routes/companion').default;`) and
index.ts:1217 (`mountRouterSync(app, '/api/v1/companion', companionRouter, { owner: 'companion' })`), unchanged; the new
handler is `router.post('/test-card', requireAuth, requireExafyAdmin, …)` in services/gateway/src/routes/companion.ts.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/companion/test-card (POST, staging, after merge: 401 without a
sign-in, 409 STAGING_DISABLED for an admin) and https://gateway.vitanaland.com/api/v1/companion/test-card (production,
only after Gate 2 and the owner's publish).
CURL_PROOF: outputs/curl-proof.txt (script outputs/curl-proof.sh): the router built by `npm run build` of this branch,
mounted at /api/v1/companion on 127.0.0.1 with the real auth middleware and no Supabase: POST without a token → 401
`UNAUTHENTICATED`; POST with an invalid bearer and a `user_id` body → 401 (auth runs before the body); GET → 404 (POST
only); `/status` → 200 (`feature_off` locally because no feature flag is set there). The admin paths are proven by the
Jest suite (outputs/green.txt), not by curl, because a real admin token and a send would need the production database.
OASIS_PROOF: one `oasis_events` row per successful test card, through `emitOasisEvent`
(services/gateway/src/services/oasis-event-service.ts:59) called in services/gateway/src/services/companion/test-card.ts
(`await emit({ … type: 'companion.test_card.sent', source: 'companion-messages' … })`), type added to the union in
services/gateway/src/types/cicd.ts. Payload: actor_user_id, moment_key, card_type, chat_message_id, mode, model; actor_role
`admin`, surface `api`. Refused and failed calls emit nothing. TEST: "sends exactly one Vitana-bot DM to the caller …"
asserts the emitted types are exactly [companion.test_card.sent] with that payload.
