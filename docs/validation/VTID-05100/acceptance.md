# VTID-05100 — Vitana Companion Messages, Phase 2 (backend): preferences API, delivery, push, reply hook — sending gated OFF

Plan: Vitana Companion Messages — sparred 5 rounds, CONVERGED, owner approved 2026-10-12. Record: `docs/validation/VTID-05099/plan-sparring.md` (plan hash `494738ed…ba63`; `docs/validation/VTID-05100/plan-sparring.md` points there). This is the backend part of Phase 2 (§A.5, §A.7, §B). The Messenger card rendering (`VitanaChatCard`), the `messenger` screen in the Unified Card System catalog, the thread pin, the voice button and the settings screen are frontend/catalog work and wait for VTID-05085 Phase 1, as the plan's sequencing requires.

**Nothing is sent by this change in any environment.** Sending needs `COMPANION_MODE=staff|live` AND the new, separate `COMPANION_SEND_ENABLED=true` AND the feature flag, on the production gateway only (staging stays `disabled-on-staging`). None of those are set by this change.

AC-1 Preferences API: `GET /api/v1/companion/preferences` returns the signed-in member's own settings, the defaults when no row exists (enabled, health + community on, business off — owner D2); `PATCH` validates with zod (booleans only, known fields only, at least one field; a body `user_id` is refused), merges onto the current settings and upserts the row keyed by the VERIFIED user id with the service-role client; both answer 401 JSON without a valid sign-in (the real `requireAuth`). A settings change emits `companion.preferences.updated`.
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts

AC-2 Delivery (`services/companion/delivery.ts`): one `chat_messages` row from the Vitana bot to the member (`message_type 'text'`, the composed text as content); `metadata` = `{ source: 'companion', moment_key, vtid: 'VTID-05100', card: { kind: 'vitana_card', v: 1, card_type, params } }` where params hold only the finite numbers from the moment's facts (no strings — labels come from the card catalog on the client, sparring F12); one presence-pacer touch on `messenger_companion`; exactly ONE push via `notifyUser('vitana_companion_message')` with `data.url = /inbox/u/<Vitana bot id>` and title/body from `tt()` in the member's locale; then `finish_companion_message('sent', text, model, chat_message_id)`. A held or failing push and a failing pacer touch never undo the DM.
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts

AC-3 A failed DM insert finishes the slot `failed`, sends no push, records no pacer touch, and emits `companion.message.failed`.
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts

AC-4 Notification type `vitana_companion_message`: TYPE_META `push_and_inapp`, priority `p2` (quiet hours hold the push), category `chat`; an admin catalog entry (member, ORB group, text `ready`, EN + DE). Catalog keys `notif.vitana_companion_message.title|body` in de (source), en, es, fr, pl, pt, ru, sr, tr, zh; `ar` is left untranslated on purpose (the coverage suite pins ar to its one hand-translated key; `tt()` falls back visibly).
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts
TEST: services/gateway/test/i18n/catalog-coverage.test.ts
TEST: services/gateway/test/vtid-04674-notification-controls.test.ts

AC-5 Sending stays off: `COMPANION_MODE=staff|live` without `COMPANION_SEND_ENABLED` exactly `true` resolves to `shadow` with reason `send_not_available` (Phase 1 behaviour unchanged); the switch never overrides staging, the feature flag, or an off/shadow mode.
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

AC-6 The tick in a sending mode: `staff` sends only to members holding a `staff`/`admin` role in their own primary tenant (`user_permitted_roles`); everyone else keeps exactly the shadow behaviour (shadow row, capped sample compose); a failed staff lookup sends to nobody. `live` sends to every eligible member, once per local day (claim with mode staff|live; the partial unique index enforces one real proactive DM per member per day across senders). Opt-out, ledger, onboarding touch and pacer checks apply as in shadow. A send always composes (no shadow cap); a failed composition finishes the slot `failed` and sends no DM. Shadow mode never delivers and the existing Phase 1 suite stays green.
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

AC-7 Reply hook: a member's text to Vitana (`handleVitanaTextReply`, `POST /api/v1/chat/vitana-reply`) fires `mark_companion_replied(p_user_id)` fire-and-forget (`companion-repository.markCompanionRepliedInBackground`); a rejected call, an error result or a synchronous throw never fails or delays the reply.
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts
TEST: services/gateway/test/chat-vitana-reply.test.ts

AC-8 Regression: the role-separation suite (route file atlas domain), the pacer surface parity suite, the scheduled-notifications and onboarding-coach suites stay green.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
TEST: services/gateway/test/vtid-04892-onboarding-journey-pacer.test.ts
TEST: services/gateway/test/vtid-04892-onboarding-coach.test.ts

Decisions taken (inside the approved plan, most conservative option):
- `chat_messages` has no `content_data` column: the client's `content_data` is persisted as `metadata` (routes/chat.ts `/send`; the frontend reads `metadata` back as `content_data`, as for DM actions and calendar invites). The card is therefore stored at `metadata.card`, next to `source`/`moment_key`/`vtid`.
- Sending needs a second explicit switch, `COMPANION_SEND_ENABLED=true`, on top of `COMPANION_MODE` — so flipping the mode alone can never start sending.
- Staff audience = a `staff` or `admin` row in `user_permitted_roles` for the member's own primary tenant (the table `check_role_permitted()` reads). Exafy admins known only through JWT `app_metadata.exafy_admin` (no `user_permitted_roles` row) are NOT included — `auth.users` metadata cannot be bulk-read through PostgREST, and the narrower audience is the conservative choice. A failed role lookup sends to nobody.
- In `staff` mode non-staff members keep the shadow behaviour (decision + capped sample), so the Phase 1 review continues while staff receive real messages.
- Card `params` keep only finite numbers from the facts (tier/pillar names are strings and are dropped) — the card never carries text.
- One OASIS event per real send/failed send (`companion.message.sent|failed`, plan §A.8) — real state transitions; shadow keeps its one aggregate event per tick. `companion.preferences.updated` per settings change.
- The push is `push_and_inapp` like every other chat type; the admin switch registers a never-seen type as OFF in the database (VTID-04674), so an admin turns `vitana_companion_message` on in the notification controls before staff mode — until then the DM still lands and the push is held (`admin_disabled`).
- `ar` gets no new keys: the catalog coverage suite requires ar.json to hold only its one hand-translated key until Arabic goes through the translate+audit pipeline.
- `COMPANION_LIVE_PERCENT` (gradual live rollout) is Phase 4 and not built here.

ROUTE_MOUNT: services/gateway/src/routes/companion.ts (already mounted at /api/v1/companion in services/gateway/src/index.ts, owner 'companion', VTID-05099) gains GET /preferences and PATCH /preferences behind requireAuth; services/gateway/src/routes/chat.ts (mounted at /api/v1/chat) POST /vitana-reply gains the fire-and-forget reply hook; POST /api/v1/scheduled-notifications/companion-tick now runs staff|live when configured.
FINAL_URL: GET /api/v1/companion/preferences; PATCH /api/v1/companion/preferences
CURL_PROOF: staging checks in docs/validation/VTID-05100/staging-tests.json — GET /api/v1/companion/preferences with an invalid bearer returns 401 JSON `{ ok: false, error: "UNAUTHENTICATED" }` and PATCH returns 401 (rejected probes, no write); GET /api/v1/companion/status returns `mode: disabled-on-staging`.

OASIS_IMPACT: yes
OASIS_PROOF: `companion.message.sent` / `companion.message.failed` per real send (services/gateway/src/services/companion/delivery.ts), `companion.preferences.updated` per member settings change (services/gateway/src/routes/companion.ts); topics added to services/gateway/src/types/cicd.ts; the aggregate `companion.tick.completed` now carries `sent`/`send_failed` in a sending mode. Proven by the emit assertions in test/vtid-05100-companion-delivery.test.ts.
