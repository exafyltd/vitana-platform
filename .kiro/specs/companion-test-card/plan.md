---
change_class: standard
---
# plan(companion-test-card): an admin sends one Vitana companion card to themselves, now

Owner, 6 Nov 2026 (Kiro Web, session kiro-exafy-202611061658-9ca9): *"I want you to send a first card now, for
example vitana index card to motivate people to improve their index. This way I want to see how the card looks
like."* Asked to choose between a preview, a staff-only morning run and a code change, the owner chose: an admin-only
"send me a test card" (option 3).

<!-- plan:begin -->
## Goal
An exafy admin presses one button in Settings › Notifications › Vitana messages (web and mobile settings screen) and,
within seconds, receives in their own Messenger thread with Vitana exactly what a member receives from the morning
companion tick for the Vitana Index moment: Vitana's composed note plus the F2 Vitana Index card under it. Nobody else
receives anything. Nothing about members' daily companion message changes.

## Today (file:line evidence on origin/main)
- Production companion runs `COMPANION_MODE=live` since run 42229489337 (6 Nov 2026), window 07:30–09:30 member local
  time; `gateway-companion-tick` (EventBridge Scheduler, every 15 min) calls `POST
  /api/v1/scheduled-notifications/companion-tick` (`services/gateway/src/routes/scheduled-notifications.ts:1754-1775`),
  which reads no body and has no user, moment or force parameter.
- `routes/companion.ts:1-83` has only `GET /status` (public), `GET /preferences` and `PATCH /preferences`
  (`requireAuth`, own row). No route sends a card on demand; `config.ts` has no allowlist.
- The tick builds a `MemberContext` (`companion-service.ts:211-228`), picks a moment (`moments.ts:366-383`), composes
  with Bedrock (`composer.ts:67`, `composeCompanionMessage`), claims a ledger slot (`companion-repository.ts:284`,
  one real DM per member per local day) and delivers (`delivery.ts:78-161`: `chat_messages` insert from
  `VITANA_BOT_USER_ID`, pacer touch, one push, ledger finish, `companion.message.sent`).
- The Vitana Index moment (`moments.ts:101-131`) uses card `F2`; it returns null without a finite Index total. Card
  metadata: `buildCompanionMetadata` (`delivery.ts:68-76`) → `{ source: 'companion', moment_key, vtid, card: { kind:
  'vitana_card', v: 1, card_type, params } }`, params = the numeric facts only (`delivery.ts:60-66`).
- Web renders the card when the sender is the Vitana bot and `isVitanaCardPayload` passes
  (`vitana-v1/src/components/messages/MessageBubble.tsx:1369-1378,1562-1566`; `src/components/vitana/VitanaChatCard.tsx:15-27`);
  the web F2 card loads the live Index itself. Mobile: `apps/mobile/src/screens/chat/bubble/Cards.tsx` (`companionCopy`,
  F2 uses `params.score`).
- `requireExafyAdmin` (`services/gateway/src/middleware/auth-supabase-jwt.ts:472-500`) gates on `identity.exafy_admin`;
  the client knows the flag as `useTenant().isExafyAdmin` (`vitana-v1/src/hooks/useTenant.tsx:45`).
- `VitanaMessagesSettings` (`vitana-v1/src/components/settings/VitanaMessagesSettings.tsx`, 92 lines) is rendered by
  `src/pages/settings/SettingsNotifications.tsx` and `src/pages/MobileSettings.tsx`; it talks to the gateway through
  `src/hooks/useCompanionPreferences.ts` (`GATEWAY_API_URL`, Supabase session bearer).
- Staging shares the production database; the companion config resolves `disabled-on-staging` there
  (`config.ts:84-85`) and the tick answers 409.

## Interfaces between lanes
**`POST /api/v1/companion/test-card`** (lane `gateway-test-card`):
- Middleware order: `requireAuth` (401) → `requireExafyAdmin` (403 `FORBIDDEN`) → body → config.
- Body (zod, strict): `{ moment_key?: 'vitana_index' }`, default `'vitana_index'`. Anything else → `400 VALIDATION`.
  The body never names a user: the recipient is always the verified caller (`identity.user_id`).
- Config: `resolveCompanionConfig()`; `disabled-on-staging` → `409 STAGING_DISABLED`; any mode that is not a send mode
  (`isSendMode`: staff or live) → `409 SEND_NOT_AVAILABLE` with the mode (the kill switch `off` therefore also stops
  test cards).
- Rate limit: one test card per admin per 60 s (in-process map) → `429 RATE_LIMITED` with `retry_after_s`.
- Supabase client: the route uses `getServiceClient()` (service role, as the tick does at
  `scheduled-notifications.ts:1766`), not the `getSupabase()` of the preference routes, because the insert writes a
  row whose `sender_id` is the Vitana bot; no client → `503 storage_unavailable`. The injectable `sb` dep receives this
  service-role client.
- Builds the caller's `MemberContext` the same way the tick does for one member (tenant from the caller's
  `user_tenants`/member row, `profiles.first_name` and timezone → `localTime`, locale via the same locale lookup the
  tick uses, `fetchVitanaIndexForProfiler`, topics all on, `lastUsed` empty) and runs the moment's own `build()`.
  `vitanaIndex.build()` null (no Index yet) → `422 NO_VITANA_INDEX`; nothing is written.
- Composes with `composeCompanionMessage(ctx, moment, config)`; failure → `502 COMPOSE_FAILED`; nothing is written.
- Writes exactly one `chat_messages` row through `repo.insertCompanionChatMessage` (sender `VITANA_BOT_USER_ID`,
  receiver = caller, `message_type: 'text'`, metadata = `buildCompanionMetadata(...)` plus `test: true`). Insert error →
  `502 INSERT_FAILED`.
- Does **not** claim or finish a ledger row, record a pacer touch, send a push or emit `companion.message.sent`, so the
  admin's real daily slot, back-off, reply tracking and all companion metrics are unchanged.
- Emits one OASIS event `companion.test_card.sent` (`source: companion-messages`, payload: actor user id, moment_key,
  card_type, chat_message_id, mode) — added to the event-type union in `services/gateway/src/types/cicd.ts`.
- `200 { ok: true, chat_message_id, moment_key, card_type, text }`.

**Client** (lane `v1-test-card-button`): `useCompanionTestCard()` posts to the route with the session bearer and maps
the error codes to messages.

## Change
### Lane `gateway-test-card` (exafyltd/vitana-platform)
- New `services/gateway/src/services/companion/test-card.ts`: `sendCompanionTestCard(deps, { userId, momentKey })`
  with injectable deps (sb, config, fetchIndex, compose, insert, emit, now) for tests. It reuses `vitanaIndex`,
  `composeCompanionMessage`, `buildCompanionMetadata`, `repo.insertCompanionChatMessage` and `localTime`; no copy of
  their logic.
- `routes/companion.ts`: the route above, rate-limit map, header comment updated.
- `types/cicd.ts`: `'companion.test_card.sent'`.
- Tests `services/gateway/test/companion-test-card.test.ts` (below).
- `docs/validation/<VTID>/staging-tests.json`.

### Lane `v1-test-card-button` (exafyltd/vitana-v1), depends on `gateway-test-card`
- `src/hooks/useCompanionTestCard.ts` (react-query mutation, same auth header helper pattern as
  `useCompanionPreferences.ts`).
- `VitanaMessagesSettings.tsx`: when `useTenant().isExafyAdmin` is true, an "Admin: send me a test card" row with a
  button (disabled while pending). Success toast "Sent — open your chat with Vitana" with a link to the Vitana DM
  (`/inbox/u/<VITANA_BOT_USER_ID>`, the URL the push already uses); error toasts for 409 (staging / sending off),
  422 (no Vitana Index yet), 429 (wait a minute), others (failed). Non-admins see no change.
- New i18n keys under `screens.settings.vitanaMessages.testCard.*` in all 11 `src/i18n/*/screens.json` (de first,
  every locale filled); toasts through `@/lib/i18n-toast`.
- Tests `src/components/settings/VitanaMessagesSettings.test-card.test.tsx` and
  `src/hooks/useCompanionTestCard.test.ts`.

## Decisions taken (conservative, listed for Gate 2)
- Only `vitana_index` now (the owner's example). The `MemberContext` built here leaves the optional signal and
  enrichment fields (`journey`, `diaryLastEntryDate`, `activeDays`, `recentFeatureTips`,
  `eligibleEnrichmentCardTypes`) unset, which is correct because `vitanaIndex.build()` reads only `ctx.vitanaIndex`.
  Adding another `moment_key` later is not a one-line change: it must also populate the fields that moment reads
  (e.g. `guided_journey_step` needs `journey`, `diary_nudge` needs `diaryLastEntryDate`).
- Composition reuses `composeCompanionMessage`, which sets `providerOverride: 'bedrock'` and a Bedrock
  `fallbackOverride` (`composer.ts:74-82`): the Bedrock-only routing rule is satisfied by construction.
- Recipient is always the caller; no admin can send to another member.
- No push, no ledger row, no pacer touch: a test card never costs the admin's real morning message and never shows in
  member metrics; the OASIS event is the audit trail.
- The kill switch applies to test cards too: allowed in `staff` and `live`, refused in `off` and `shadow`.
- No Index → 422 instead of a fallback card: the F2 card shows the live Index, so a card without one would be
  misleading.
- Not on staging: staging shares the production database, so the route answers 409 there (the companion rule).
- Not a member feature: no What's New card.

## Lanes
- `gateway-test-card` (platform, seat exafy, `depends_on: []`)
- `v1-test-card-button` (v1, seat exafyltd, `depends_on: [gateway-test-card]`)
Shared and hot files: `src/i18n/*/screens.json` (one lane), `services/gateway/src/routes/companion.ts` (one lane).
Serial on purpose: the button must never be visible on staging or production before the route exists there.

## Tests and commands
- Gateway Jest `test/companion-test-card.test.ts` (red on base: the route and the module do not exist), with injected
  deps and a supertest app around the router:
  401 without a token; 403 for a non-admin; 400 for an unknown `moment_key` or a `user_id` in the body (strict);
  409 `STAGING_DISABLED` on staging config; 409 `SEND_NOT_AVAILABLE` for `off`/`shadow`; 422 when the Index is null and
  nothing is inserted; 502 on compose failure and nothing is inserted; success inserts exactly one row whose
  `receiver_id` is the caller, `sender_id` the Vitana bot, metadata passes the same shape check as a tick message
  (`card.kind/v/card_type = F2`, numeric params) plus `test: true`; no ledger claim, no pacer touch, no notify call;
  one `companion.test_card.sent` event; a second call inside 60 s → 429.
  Existing suites stay green: `vtid-05099-companion-messages`, `vtid-05100-companion-delivery`,
  `vtid-05368-messenger-companion-verification`, `npm run test:roles`; plus `npm run typecheck` and `npm run build`.
- v1 Vitest: the row renders only for an exafy admin; pressing calls the hook once and disables while pending; each
  error code shows its message; success shows the DM link. Existing `VitanaMessagesSettings.vtid-05100.test.tsx`
  stays green; `npm test`, `npm run lint`, `npm run build`, `npm run i18n:inventory`.
- Staging (read-only, rule 48): gateway `staging-tests.json` probes `POST /api/v1/companion/test-card` without a token
  (`rejected_probe`, expects 401 JSON, proves the route is mounted) and `GET /api/v1/companion/status` (expects
  `disabled-on-staging`). A real send needs a production write, so the send itself is **not verified on staging**; the
  unit tests cover it. After Gate 2 and the owner's publish, the owner presses the button once in production: that is
  the owner's own action on their own account, not a test suite.

## Measurement (collaboration §8b)
`docs/validation/<plan VTID>/timings.json` as usual. Product check: the owner sees the card in their Vitana DM on web
and in the phone app.

## Risks
- A new write route on production. Mitigation: exafy admin only, recipient fixed to the caller, strict body, 60 s
  rate limit, OASIS audit, refused on staging and when sending is off.
- Bedrock cost: one compose per press, at most one per admin per minute.
- The owner's account must carry `exafy_admin`; otherwise the button is hidden and the route answers 403 (reported, not
  worked around).
- Two publishes are needed (gateway, then frontend) at Gate 2; the frontend button calls a route that must already be
  live, which the `depends_on` order and Gate 2 order guarantee.

## Unchanged
The companion tick, moment ranking, ledger, pacer, push settings (`vitana_companion_message` admin switch stays as is),
member preferences, production env, protected gate files, production workflows, every existing test.
<!-- plan:end -->
