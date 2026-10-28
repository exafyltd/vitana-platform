# Plan sparring record — Vitana Companion Messages (VTID-05099 / VTID-05100 / VTID-05101 / VTID-05102)

- Plan hash (sha256 of the text between the plan markers): `494738edb276213257cff5f12207d8a1c190cd87368e791af0b1aec88d8fba63`
- Partner: `plan-sparring-partner` agent (independent, read-only), Claude Code session https://claude.ai/code/session_016Y9ADzi2tLSdr8pKgai5sB
- Rounds: 5 (standard cap 3, plus 2 rounds after the owner revised decision D3 at Gate 1).
  - R1: 1 blocker (F1), 4 majors (F2–F5), 3 minors (F6–F8).
  - R2: F1 disputed → new blocker F9; new minor F10; F2–F8 closed.
  - R3: all closed — CONVERGED.
  - Owner feedback at Gate 1 (D3 revised: every message carries a Unified Card System card) → R4: new major F11, minor F12.
  - R5: all closed — CONVERGED.
- Verdict: **CONVERGED**
- Owner approval: 2026-10-12, "Yes" in the Claude Code session above (Gate 1), plan hash `494738edb276213257cff5f12207d8a1c190cd87368e791af0b1aec88d8fba63`
- VTIDs: VTID-05099 (Phase 1, engine in shadow), VTID-05100 (Phase 2, cards in the Messenger, staff; depends on VTID-05085), VTID-05101 (Phase 3, remaining moments; depends on VTID-05086/05087), VTID-05102 (Phase 4, rollout)

## Partner findings (verbatim summary) and planner answers

| # | Sev | Finding | Answer |
|---|---|---|---|
| F1 | blocker | Preferences planned on `user_preferences.metadata` — that column shape is not how the live table works | ACCEPTED → superseded by F9 |
| F2 | major | Match messenger and companion could both DM on the same day during Phases 1–2 | ACCEPTED — both claim the same ledger slot; DB-enforced |
| F3 | major | Back-off would scan `chat_messages` | ACCEPTED — `replied_at` on the ledger, written on reply / card tap |
| F4 | major | Pacer surface needs the `user_proactive_touches.surface` CHECK widened | ACCEPTED — explicit in the migration |
| F5 | major | Shadow mode would call the LLM for every member daily | ACCEPTED — compose only a capped sample (`COMPANION_SHADOW_COMPOSE_LIMIT`, default 20/day) |
| F6 | minor | Permanent pin of the Vitana thread is intrusive | ACCEPTED — on top only while unread |
| F7 | minor | No example intent | ACCEPTED — morning_greeting intent added |
| F8 | minor | `notifyUser` takes no timezone | ACKNOWLEDGED — the local window controls timing |
| F9 | blocker | Live `user_preferences` is flat (upsert on `user_id`), not key-value | ACCEPTED — dedicated `companion_preferences` table |
| F10 | minor | Push text hardcoded English in the match messenger | ACCEPTED — `tt()` + `getUserLocale()` for the companion push |
| F11 | major | Feature-card (F*) dismiss is client-side only in VTID-05085 | ACCEPTED — no X on F-cards in chat; E/G cards use the shared server dismiss |
| F12 | minor | Card label source | ACCEPTED — labels resolved at render time from the card catalog; `content_data.card` stores no strings |

---

# Plan: Vitana Companion Messages (proactive personal Vitana DM in the Messenger)

**Change class:** standard (migrations, new gateway routes/scheduled job, LLM call, frontend changes in two repos)
**Repos:** exafyltd/vitana-platform (gateway, migrations, EventBridge script), exafyltd/vitana-v1 (Messenger UI, settings)

<!-- plan:begin -->

## Goal
Vitana proactively writes to each member in their private Vitana DM thread in the Messenger —
at most ONE message per member per day — as a personal life companion: a good-morning greeting,
Vitana Index status, next Guided Journey step, a new match, a feature tip, a diary nudge, an
upcoming event, or (opt-in only) a business / income-stream invitation. Each message is
conversational: the member replies by text (existing reply pipeline) or opens voice (ORB).

## Owner decisions (fixed, not for re-argument)
- D1: Maximum 1 companion message per member per day (all members, default).
- D2: Health + community topics on by default; business/income topics are opt-in.
- D3 (revised 2026-10-12): The Vitana cards are Vitanaland's recognizable, shared UX — same
  look and action button on every screen — and from now on they appear in the Messenger too.
  Every companion message carries one Vitana card from the Unified Card System catalog
  (VTID-05085, owner-approved 2026-10-12, executor Kiro). The Messenger becomes one more
  screen of that system; this plan never defines its own card look.

## Existing building blocks reused (verified by research)
- Vitana bot DM: `VITANA_BOT_USER_ID` (`services/gateway/src/lib/vitana-bot.ts:9`), rows in
  `chat_messages`; replies via `POST /api/v1/chat/vitana-reply` → `handleVitanaTextReply`
  (`routes/chat.ts:251,513`), thread id `vitana-dm:${tenantId}:${userId}`, rebuilds last 12 turns
  from `chat_messages` (so a proactive bot message automatically becomes context for the reply).
- Action buttons on bot messages: `content_data.actions` rendered by `VitanaMessageActions.tsx`
  (VTID-03587).
- Prior art: `services/proactive-match-messenger.ts` (VTID-01270) — inserts a bot DM + push
  `orb_proactive_message`, 1/day, template text (hardcoded English).
- Bot messages get no automatic push (`notify_on_chat_message()` early-returns for the bot), so
  the engine calls `notifyUser()` itself (`services/notification-service.ts:729`), which applies
  admin per-type switch, push_enabled, category opt-out, member quiet hours in member timezone.
- Pacing: `services/guide/presence-pacer.ts` — `canSurfaceProactively()` / `recordTouch()`,
  tables `user_proactive_touches`, `user_proactive_pause`; surface is a CHECK-constrained enum.
- Scheduling: EventBridge Scheduler → shared Lambda → gateway POST with `X-Gateway-Internal`
  (`scripts/aws/setup-eventbridge-cron-migration.sh`), auth `middleware/scheduled-notifications-auth.ts`.
- Content sources: `fetchVitanaIndexForProfiler` (`user-context-profiler.ts:543`), Guided
  Journey, matches (proactive-match-messenger), `data/feature-tips.ts`, `feature_announcements`
  (What's New), diary reminder, upcoming events, wallet/referral/Find a Partner/Business Hub.
- Personalisation: `getUserLocale` / `buildLocalizedSystemPrompt` (`i18n/llm-locale.ts:82`),
  `getUserContextSummary`, `getCurrentFacts`, `fetchLifeCompass`.
- Recipient exclusion: `fetchExcludedTestServiceAccountIdsStrict`
  (`lib/excluded-test-service-accounts.ts:48`) — service_bot_accounts + notification_test_actors.

## Dependency on the Unified Card System (VTID-05085/05086/05087)
- That plan defines the catalog (E1–E11 enrichment, F1–F11 feature, G1–G3 boost; G4 deferred),
  the server catalog `services/gateway/src/services/enrichment/card-catalog.ts`, the completion
  resolver, `GET /api/v1/enrichment-cards?screen=` + `POST /dismiss`, table
  `user_enrichment_cards`, and the frontend `VitanaCardActionButton` + extended `VitanaFeature`
  on the existing `VitanaRecommendationCard` shell. None of it is merged yet (verified).
- This plan CONSUMES those pieces and never edits Kiro's files in parallel. The only additions
  to the card system are (a) a `messenger` screen value and (b) a single business card (Phase
  3), each landed as a small follow-up PR to the card system's own files AFTER its phase that
  creates them has merged — never concurrently.
- Sequencing: Phase 1 here (engine in shadow, text only, no card rendering) does not depend on
  it. Phase 2 (cards in chat) starts only after VTID-05085 Phase 1 has merged. If it has not,
  Phase 2 waits — it does not build a stand-in card.

## Design

### A. Engine (gateway, new `services/gateway/src/services/companion/`)
1. `companion-scheduler.ts` — route `POST /api/v1/scheduled-notifications/companion-tick`
   (internal-auth, same middleware as other scheduled routes), fired every 15 min by a new
   EventBridge schedule (added to the existing setup script). Selects eligible members whose
   LOCAL time (profile timezone; fallback Europe/Berlin) is inside their delivery window
   (default 07:30–09:30 local; morning greeting is the default moment), who have not received
   a companion message today (local date), are not excluded test/service accounts, have
   companion messages enabled, and are not paused. Batched (page size 200), bounded per tick.
2. `moments/*.ts` — "moment generators", each a pure function `(memberCtx) → Candidate | null`
   with `{ moment_key, card_type (catalog id), topic: 'health'|'community'|'business',
   intent (English, §13b), facts (structured data), priority }`. Each moment is "which card,
   and why today". Mapping: `morning_greeting` → F4 Talk to Vitana; `vitana_index` → F2;
   `guided_journey_step` → F1; `diary_nudge` → F3 (or G3 Streak at Risk when it triggers);
   `new_match` → F5 / G2; `feature_tip` → F8; `invite_friend` → F7; `profile_step` →
   E1–E11 / G1 (only cards the completion resolver reports NOT done and NOT in dismiss
   cooldown); `business_invite` → the new business card (opt-in, Phase 3). Card eligibility
   comes from the same catalog + completion resolver + `user_enrichment_cards` state the other
   screens use, called for `screen=messenger` — so a card done or dismissed anywhere never
   appears in chat, and vice versa. New catalog cards become available to the Messenger by
   adding `messenger` to their screen list plus one generator file.
3. `companion-ranker.ts` — picks ONE candidate: filters by member topic toggles, drops any
   moment_key sent in the last N days (anti-repeat window per moment, stored in the ledger),
   prefers weakest-pillar / goal relevance from facts, deterministic tie-break. If nothing
   qualifies → morning_greeting.
4. `companion-composer.ts` — writes the message with Claude on Bedrock via the existing LLM
   router (new stage `companion_compose` in `llm_routing_policy`, provider `bedrock`, fallback
   another Bedrock model or hard fail — never Google). Input: intent + facts + member first
   name + memory summary; system prompt built with `buildLocalizedSystemPrompt` (member locale,
   du-form). No hardcoded sentences (rule 41). Output validated: length cap (~600 chars),
   no medical claims guardrail line in prompt, non-empty, language check by locale heuristic.
   Compose failure → skip member today (logged), never a template fallback.
5. `companion-delivery.ts` — inserts `chat_messages` row (sender = bot, receiver = member,
   body = Vitana's composed personal note, `content_data.card = { kind: 'vitana_card', v: 1,
   card_type, params }` (params = only the live values the card shows, e.g. Index score;
   card title/description/button label come from the catalog, localized, never from the LLM —
   so the card looks and reads the same as on every other screen), `metadata.source='companion'`,
   `moment_key`). In Phase 1 (before the catalog exists) the card field is written but not
   rendered; records
   pacer touch on new surface `messenger_companion`, writes ledger row, then ONE push via
   `notifyUser(type='vitana_companion_message', data.url='/inbox/u/<bot id>')`. If the push is
   suppressed (quiet hours/opt-out), the DM still lands (it is the inbox, not an interruption).
6. Idempotency: new table `companion_messages_ledger (user_id, local_date, moment_key,
   chat_message_id, status, composed_by_model, created_at)` with UNIQUE(user_id, local_date)
   — the DB enforces D1 even under concurrent ticks. Insert ledger row first (claim), then
   compose/send, then mark sent/failed.
7. Shadow mode: `COMPANION_MODE=off|shadow|staff|live` (+ `COMPANION_LIVE_PERCENT`). Shadow
   composes and writes the ledger with status `shadow` and the would-be text, but sends no DM
   and no push. Staff = only exafy staff/admin roles. Default `off`.
8. OASIS events: `companion.message.sent|skipped|failed` per member (no event for ticks).

9. Shadow cost control: `shadow` runs scheduler + ranker for everyone but does NOT compose —
   it logs moment_key + facts. Only a sample of at most `COMPANION_SHADOW_COMPOSE_LIMIT`
   (default 20) members per day get a full compose, so text quality can be reviewed.
10. Intent example (pattern for every generator, rule 41): morning_greeting →
   `intent: "Warmly greet the member by first name, acknowledge the morning, remind them
   they can text you here or press the ORB to talk, and offer one small helpful step for
   today."` English intent only; never a finished sentence in any language.

### B. Respecting the member
- Preferences live in a NEW dedicated table `companion_preferences (user_id PK, tenant_id,
  enabled bool, topic_health bool, topic_community bool, topic_business bool,
  window text default 'morning', updated_at)`, RLS: member reads/updates own row only.
  No row = defaults enabled=true, health=true, community=true, business=false (D2).
  Not `user_preferences`: that live table is flat with `onConflict: 'user_id'` upserts and
  already carries stt_language/timezone/pacer metadata — a dedicated table avoids colliding
  with those writers. Gateway `GET/PATCH /api/v1/companion/preferences` reads/writes it.
- "Not now / pause" from the chat: the reply pipeline's existing dismissal tool writes
  `user_proactive_pause`; the scheduler honours it.
- Back-off: ledger gets `replied_at TIMESTAMPTZ`. `handleVitanaTextReply` (member text reply)
  and the action-button tap path set `replied_at` on the member's latest un-replied `sent`
  ledger row (single indexed UPDATE on (user_id, local_date DESC)). The scheduler reads only
  the ledger: last 3 `sent` rows with NULL replied_at → every other day; last 7 → weekly;
  any reply resets. No scan of `chat_messages`.
- New notification type `vitana_companion_message` in gateway `TYPE_META` (category `chat`,
  priority p2 so quiet hours apply). Push title/body via `tt()` catalog keys + `getUserLocale()`
  (§13b) — never hardcoded English; the DM body itself is the LLM-composed text + frontend `notification-types.ts` with route to the DM.
- D1 across both senders from Phase 1: `proactive-match-messenger` claims the same
  `companion_messages_ledger` row (moment_key `new_match`) before it sends; the
  UNIQUE(user_id, local_date) makes the DB refuse a second Vitana proactive DM that day,
  whichever sender comes first. In Phase 3 it is folded into the engine as the `new_match`
  generator (and gets localized LLM composition instead of its English template).

### C. Messenger frontend (vitana-v1)
- Card in the chat: `MessageBubble.tsx` default branch renders, for bot messages,
  Vitana's text and below it `<VitanaChatCard>` when `content_data.card` passes a versioned
  type guard (same pattern as `isInviteCard`, `calendar-window-client.ts:392`). `VitanaChatCard`
  is a thin adapter: it looks up `card_type` in the card system's frontend catalog and renders
  the SAME `VitanaRecommendationCard` shell, colour token, `VitanaCardActionButton` shape/icon/
  label and deep link as every other screen. Unknown or not-yet-shipped `card_type` → text only
  (never a broken card). Labels (title, description, button) are resolved at render time from
  the same frontend catalog/config the card strips use (feature cards: `FEATURE_CONFIG`;
  enrichment/boost: the card system's localized tips) — `content_data.card` stores no strings,
  so the card follows the member's current locale.
  Dismiss, following the card system's own split (VTID-05085 §3.4): enrichment/boost cards
  (E*, G*) show the X and call the shared server `POST /dismiss`, so the dismiss holds on every
  screen and the engine's eligibility check sees it. Feature cards (F*) in chat show NO X —
  the card system keeps their dismiss client-side only, which the gateway engine cannot read;
  in chat their repetition is governed by the companion anti-repeat window and back-off.
  Tapping the action button marks the ledger `replied_at`.
- Existing `content_data.actions` buttons stay supported for normal Vitana replies.
- Vitana thread sits at the top of the inbox while it has an unread Vitana message; once
  read it sorts by activity like any other thread (`Messages.tsx` sort). The synthetic
  placeholder thread (`useGlobalMessages.ts:776-801`) stays only while no messages exist.
- Use `vitanaBotIdentity.ts` everywhere (remove duplicate constant in `useGlobalMessages.ts:541`).
- In the Vitana thread only: a "Talk to Vitana" voice button in the header that calls
  `activateOrb()` (ORB FAB stays hidden in chats as today).
- Settings: a "Vitana messages" section (enable, topic toggles incl. business opt-in) in the
  existing notification/assistant settings screen. All strings DE-first i18n, all 11 locales,
  RTL-safe.
- No What's New entry until Phase 4 (feature not finished/flagged before then).

### D. Business / income moments
- Only built on existing real surfaces (Find a Partner, Business Hub `create_service`, referral
  earnings, marketplace). Only for members with `topics.business=true`. Commission must never
  influence selection (§13c rule 4) — ranker has no commission input.

### E. Fixes along the way
- `automation-handlers/sharing-growth.ts:17` and `onboarding-growth.ts:19` fall back to a wrong
  bot id (`…0000`) — point them at `lib/vitana-bot.ts`.

## Phases
1. Engine skeleton + ledger + pacer surface + `morning_greeting` + `vitana_index`, mode `shadow`
   (card_type recorded, not rendered). Independent of VTID-05085.
2. After VTID-05085 Phase 1 merged: `messenger` screen added to the card system, `VitanaChatCard`
   in the chat, thread on top while unread, voice button, settings, preferences API; mode `staff`.
3. Remaining generators (incl. enrichment/boost cards once VTID-05086/05087 ship them), the
   business card added to the catalog, fold proactive-match-messenger in, back-off.
4. `live` at 10% → 50% → 100% (flag only), What's New entry.

## Test plan
- Jest (gateway): ranker (topic filter, anti-repeat, business opt-in), scheduler eligibility
  (local window, timezone, exclusions, pause, back-off), ledger idempotency (unique per day,
  concurrent tick), delivery (DM insert + exactly one notifyUser call, shadow sends nothing),
  composer (localized prompt used, no hardcoded spoken string; compose failure → skip),
  test/service accounts never selected.
- Vitest (frontend): `VitanaChatCard` renders the identical shell/colour/button as the same
  card on Home for each catalog id; unknown card_type → text only; dismiss calls the shared
  endpoint; thread on top while unread, voice button only in Vitana thread, settings toggles.
- Jest: moment→card mapping only offers cards the completion resolver says are not done and
  not in cooldown; card title/label never come from the LLM output.
- Staging (read-only Playwright, `docs/validation/<VTID>/staging-tests.json`): Vitana thread
  pinned at top, header voice button visible, settings section renders. Gateway staging probe:
  `GET /api/v1/companion/preferences` returns JSON for test user. No sends on staging
  (mode stays shadow on staging; staging uses prod Supabase).
- Regression: existing `npm run test:roles`, support and operator suites stay green.

## Scope (files)
Platform: `services/gateway/src/services/companion/**` (new), `routes/scheduled-notifications.ts`
(or new `routes/companion.ts`), `index.ts` (mount), `services/notification-service.ts` (TYPE_META),
`services/guide/presence-pacer.ts` (surface union), `services/proactive-match-messenger.ts`
(Phase 3), `automation-handlers/{sharing,onboarding}-growth.ts`,
`supabase/migrations/<ts>_companion_messages.sql` — explicitly: (0) `companion_preferences` table (B); (1) `companion_messages_ledger`
with UNIQUE(user_id, local_date), `replied_at`, index (user_id, local_date DESC), RLS
service-role only; (2) ALTER the `user_proactive_touches.surface` CHECK (from migration
20261005130000) to add `messenger_companion` in step with the `ProactiveSurface` union — a
surface missing from the CHECK is silently not counted; (3) `llm_routing_policy` row
`companion_compose` → bedrock,
`scripts/aws/setup-eventbridge-cron-migration.sh`, `DATABASE_SCHEMA.md`, tests.
Card system (follow-up PRs after its phases merge, never concurrent with Kiro): add `messenger`
to screen lists in `services/gateway/src/services/enrichment/card-catalog.ts` and the frontend
catalog; one business card entry (Phase 3).
Frontend: `src/components/messages/MessageBubble.tsx`, new `src/components/messages/VitanaChatCard.tsx`,
`src/pages/Messages.tsx`, `src/hooks/useGlobalMessages.ts`,
`src/components/messages/ConversationView.tsx`, settings component, `src/lib/notification-types.ts`,
`src/i18n/*/…json`, `docs/validation/<VTID>/staging-tests.json`, tests.

<!-- plan:end -->

---

## Round 1 — Planner responses

- **F1 [blocker] preference storage** — ACCEPTED. Now key-value rows in existing `user_preferences`, category `companion`, keys `enabled`/`topics`/`window`, defaults when no row (B).
- **F2 [major] two DMs/day during Phases 1–2** — ACCEPTED (variant of option c). `proactive-match-messenger` claims the same ledger row (UNIQUE(user_id, local_date)) before sending from Phase 1, so the DB refuses a second proactive DM whichever sender is first. Folded into the engine in Phase 3. Not option (a): disabling matches would remove a live member-facing feature before its replacement exists.
- **F3 [major] back-off query** — ACCEPTED. `replied_at` on the ledger, set by `handleVitanaTextReply` and the button-tap path; scheduler reads only the ledger; index (user_id, local_date DESC).
- **F4 [major] pacer CHECK** — ACCEPTED. Migration list now explicitly alters the `user_proactive_touches.surface` CHECK (20261005130000) alongside the union.
- **F5 [major] shadow LLM cost** — ACCEPTED. Shadow skips compose; full compose only for a sample capped by `COMPANION_SHADOW_COMPOSE_LIMIT` (default 20/day) (A.9).
- **F6 [minor] pinning UX** — ACCEPTED. On top only while an unread Vitana message exists; otherwise normal activity order.
- **F7 [minor] intent example** — ACCEPTED. Example English intent for morning_greeting added (A.10).
- **F8 [minor] notifyUser timezone** — ACKNOWLEDGED, no change: the scheduler's local-window filter controls timing; quiet hours are a secondary gate. Members with no timezone use the Europe/Berlin fallback already stated in A.1.
- **Line-number nits** (chat.ts thread id at :528; profiler alias at :548) — ACCEPTED, noted for implementation.

## Round 2 — Planner responses

- **F1 / F9 [blocker] preference storage (disputed → re-answered)** — ACCEPTED, option (b): dedicated `companion_preferences` table (one row per member, RLS own-row). Rejected option (a): the live `user_preferences` is upserted `onConflict: 'user_id'` by other writers, so a second per-user row with a different `preference_type` risks conflicting with them; a dedicated table has no shared writers. Migration list updated (item 0).
- **F10 [minor] English push text** — ACCEPTED. `vitana_companion_message` push title/body go through `tt()` + `getUserLocale()`; the folded-in match message loses its English push strings in Phase 3.

## Owner feedback at Gate 1 (2026-10-12) — plan revised
Owner: "the cards become a recognizable part of the overall Vitanaland journey and UX. They
appear in many different screens and always as the same visual appearance with action button
to take action. This is a major experience within Vitanaland and from here on also in
Messenger." → D3 revised; every companion message carries one Unified Card System card;
Messenger becomes a screen of that system; dependency + sequencing on VTID-05085 added;
moments now map to catalog card ids; shared dismiss/completion state; VitanaChatCard adapter.

## Round 4 — Planner responses
- **F11 [major] feature-card dismiss in chat** — ACCEPTED, option (b) for F-cards plus server dismiss for E/G: E*/G* cards in chat keep the X and use the shared `POST /dismiss`; F* cards in chat show no X (their dismiss is client-only by VTID-05085 design, invisible to the engine); repetition of F-card moments is governed by the companion anti-repeat window + back-off. No change to the card system's dismiss contract. Not (a): it would change VTID-05085's approved contract mid-build.
- **F12 [minor] label source** — ACCEPTED. `VitanaChatCard` resolves labels at render time from the same frontend catalog/config as the strips; `content_data.card` stores no strings.
