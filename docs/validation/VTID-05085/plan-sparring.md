# Plan sparring record — Unified Card System (VTID-05085 / VTID-05086 / VTID-05087)

- Plan hash (sha256 of the text between the plan markers): `e7abbebb1e777f3aa27eea0356a5ca697328ee180c32a24e04150e2f5a238ab7`
- Partner: `plan-sparring-partner` agent (independent, read-only), Claude Code session https://claude.ai/code/session_0134JqjWdFLkW6ju9Yk8YSEJ
- Rounds: 2 — round 1: 1 blocker, 7 majors, 4 minors, 3 questions; round 2: all closed, 1 new minor (F13) accepted
- Verdict: **CONVERGED**
- Owner approval: 2026-10-12, "Yes" in the Claude Code session above (Gate 1)
- VTIDs: VTID-05085 (Phase 1), VTID-05086 (Phase 2), VTID-05087 (Phase 3). Executor: Kiro — see `docs/validation/VTID-05085/KIRO-INSTRUCTIONS.md`

---

# Unified Card System — Implementation Plan

**Change class:** `standard`
**Scope:** `vitana-v1` (/home/user/vitana-v1 — frontend components, hooks, screens), `vitana-platform` (/home/user/vitana-platform — gateway endpoint, migration, feature-tips, completion resolver)
**Executor:** KIRO (submitted by the user for KIRO to execute)

<!-- plan:begin -->

## 1. Summary

90% of Vitana users never upload a profile photo. Engagement features like calendar sync, contact import, and social connects sit unused because there is no in-app nudge guiding users toward them. Meanwhile, Vitana's proactive cards (Vitana Index, Guided Journey, Invite Friend, Find a Match, Did You Know) only appear on the Home feed — users on other screens never see them.

This plan delivers a **Unified Card System**: 26 cards in 3 categories (11 enrichment, 11 feature, 4 engagement boost) rendered through the existing `VitanaRecommendationCard` shell, appearing consistently across 9+ screens. Every card shares the same Vitana identity header (ORB avatar + "Vitana" brand + feature badge), the same 138px fixed height, the same rounded-2xl shape — but each is visually differentiated by a unique color accent and a distinctive action button (round, pill, or rounded-square shape) so users learn to recognize cards by color + button shape at a glance.

Enrichment cards disappear permanently once the user completes the action (server-tracked via existing tables). Dismissed enrichment cards return after a 7-day cooldown (server-tracked, extending the `user_nudge_state` pattern). Feature cards are always present, contextual per screen. Engagement boost cards appear when specific triggers fire.

## 2. Card Catalog

### 2A. Enrichment Cards (11) — disappear when action completed, 7-day dismiss cooldown

| ID | Name | Color (HSL token) | Button Shape | Button Icon + Label | Completion Signal | DeepLink | Screens |
|---|---|---|---|---|---|---|---|
| E1 | Upload Profile Photo | amber 42° `domain-health` | round | 📷 Upload | `profiles.avatar_url IS NOT NULL` | `/me/profile#avatar` | Home (pos 1), Profile |
| E2 | Add Your Bio | orb steel-blue 235° `sys-vitana-card` | pill | ✏️ Write bio | `profiles.bio IS NOT NULL AND length(bio) > 50` | `/me/profile#about` | Home (pos 3), Profile |
| E3 | Make Your First Post | rose-pink 330° `domain-community` | pill | 📝 Post now | `profile_posts count > 0 for user` | opens the existing create-post sheet (CreateContentPopup / MobileCreatePostSheet) — no `/comm/create-post` route exists | Home, Profile, Community/Media Hub, Make a Post |
| E4 | Add Your Interests | teal 173° `from-emerald-200 to-sky-300` | pill | 🎯 Pick interests | `profiles.interests array non-empty` (new column) | `/me/profile#interests` | Home, Profile, Longevity Journey |
| E5 | Set Your Location | teal 173° `from-emerald-200 to-sky-300` | pill | 📍 Add location | `profiles.location IS NOT NULL` | `/me/profile#location` | Home, Profile, Longevity Journey |
| E6 | Connect Instagram | blue 217° `gradient-follow` | rounded-square | 📸 Connect | `social_connections row for 'instagram' with is_active = true AND disconnected_at IS NULL` | social-connect OAuth flow | Home, Profile, Community/Media Hub |
| E7 | Connect Facebook | blue 217° `gradient-follow` | rounded-square | 🔗 Connect | `social_connections row for 'facebook' with is_active = true AND disconnected_at IS NULL` | social-connect OAuth flow | Home, Profile, Community/Media Hub |
| E8 | Connect Your Calendar | purple 280° `calendar-primary` | pill | 📅 Connect | `connected_app_settings row for any calendar app (google-calendar, outlook-calendar, apple-calendar)` | `/connectors` | Home, Profile, Calendar |
| E9 | Import Your Contacts | sky 199° `sys-vitana-accent` | pill | 👥 Import | `contacts count > 0 for user` | `/connectors#contacts` | Home, Profile |
| E10 | Enable Notifications | red-orange 8° `sys-autopilot` | pill | 🔔 Enable | `user_device_tokens row for user with revoked_at IS NULL` (FCM token registered) | notification permission flow | Home, Profile, Autopilot |
| E11 | Upload Cover Photo | amber 42° `domain-health` | round | 🖼️ Upload | `profiles.cover_url IS NOT NULL` | `/me/profile#cover` | Home, Profile |

### 2B. Feature Cards (11) — always present, contextual per screen

| ID | Name | Color (HSL token) | Button Shape | Button Icon + Label | Presence | DeepLink | Screens |
|---|---|---|---|---|---|---|---|
| F1 | Guided Journey | violet 262° `sys-feature-new` | pill | ▶ Play episode | always | `/autopilot` | Home, Longevity Journey, Calendar, Autopilot, Talk to Vitana |
| F2 | Vitana Index | teal 173° `from-emerald-200 to-sky-300` | pill | 💓 Check health | always | VitanaIndexSheet event | Home, Longevity Journey, Profile, Autopilot, Talk to Vitana, Vitana Index |
| F3 | Daily Diary | amber 42° `domain-health` | round | 🎙 Record | always | `/daily-diary` | Home, Longevity Journey, Vitana Index, Autopilot, Talk to Vitana |
| F4 | Talk to Vitana | orb steel-blue 235° `sys-vitana-card` | round | ◉ Ask Vitana | always | `/assistant` | Home, Profile, Vitana Index |
| F5 | Find a Match | blue 217° `gradient-follow` | pill | 👥 See matches | always | `/me/matches` | Home, Longevity Journey, Community/Media Hub, Make a Post |
| F6 | Autopilot | red-orange 8° `sys-autopilot` | pill | ⚡ Open | always | `/autopilot` | Home, Calendar, Vitana Index |
| F7 | Invite Friend | sky 199° `sys-vitana-accent` | rounded-square | ↗ Share invite | always | share-invite flow | Home, Profile, Community/Media Hub, Make a Post |
| F8 | Did You Know | indigo 250° `sys-feature-tip` | pill | 💡 Try it | always (server-paced via DYK tour) | per-tip deepLink | Home, Longevity Journey, Calendar |
| F9 | Calendar | purple 280° `calendar-primary` | pill | 📅 Open calendar | always | `/calendar` | Home, Autopilot |
| F10 | Upload Video/Music | rose-pink 330° `domain-community` | round | 🎬 Create | always | opens the existing create-post sheet in media mode — no `/comm/create-post` route exists | Community/Media Hub, Make a Post |
| F11 | Discover | purple 265° `domain-discover` | pill | 🧭 Browse | always | `/discover` | Home |

### 2C. Engagement Boost Cards (3 in scope; G4 deferred) — conditional triggers

| ID | Name | Color (HSL token) | Button Shape | Button Icon + Label | Trigger | DeepLink | Screens |
|---|---|---|---|---|---|---|---|
| G1 | Complete Your Profile | orb steel-blue 235° `sys-vitana-card` | pill | 🚀 Continue setup | `useProfileProgress.completionPercentage < 80` | `/me/profile` | Home, Profile |
| G2 | Unread Matches | blue 217° `gradient-follow` | pill | 💬 See who matched | `unread match notifications > 0` | `/me/matches` | Home |
| G3 | Streak at Risk | amber 42° `domain-health` | round | 🎙 Log today | `diary streak > 3 AND no entry yesterday` — streak computed by reusing the existing streak logic in `services/gateway/src/services/diary-streak-celebrator-repository.ts` (no new streak table) | `/daily-diary` | Home, Longevity Journey, Vitana Index |
| G4 | Earn VTNA Tokens | — | — | — | **DEFERRED** — no `vtna_rewards` table exists; rewards are credited at claim time via `claim_capped_reward()` (VTID-04878), so there is no "unclaimed reward" state to detect. Out of scope until a separate plan defines one. | — | — |

## 3. Architecture

### 3.1 New Gateway Endpoint

**`GET /api/v1/enrichment-cards?screen=<screen>`**

Returns a prioritized list of cards the user should see on the given screen, with completion/trigger state pre-resolved server-side.

```
Request:
  GET /api/v1/enrichment-cards?screen=home
  Authorization: Bearer <jwt>

Response:
{
  "cards": [
    { "card_type": "E1", "category": "enrichment", "completed": false, "dismissed_until": null, "priority": 1 },
    ...
  ],
  "profile_completion_pct": 45
}
```

The endpoint:
1. Reads user profile fields (avatar_url, bio, location, cover_url, interests) from `profiles`
2. Counts posts from `profile_posts`
3. Checks `social_connections` for instagram/facebook
4. Checks `connected_app_settings` for calendar apps
5. Counts `contacts`
6. Checks `user_device_tokens` for active FCM registration (revoked_at IS NULL)
7. Reads `user_enrichment_cards` for dismissal state
8. Filters by `screen` parameter to return only relevant cards
9. Sorts: enrichment by engagement-value priority, boost by trigger urgency, feature by screen relevance

Register in `services/gateway/src/routes/` as a new router file `enrichment-cards.ts`, mounted on the Express app alongside existing routes in `src/index.ts`.

### 3.2 New Table: `user_enrichment_cards`

Migration file: `supabase/migrations/20261012000000_unified_card_system.sql`

```sql
CREATE TABLE IF NOT EXISTS user_enrichment_cards (
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_type     TEXT        NOT NULL,
  dismissed_at  TIMESTAMPTZ DEFAULT NULL,
  cooldown_days INT         NOT NULL DEFAULT 7,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_type)
);
CREATE INDEX idx_user_enrichment_cards_user ON user_enrichment_cards (user_id);
ALTER TABLE user_enrichment_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own enrichment cards" ON user_enrichment_cards FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own enrichment cards" ON user_enrichment_cards FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own enrichment cards" ON user_enrichment_cards FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Service role full access" ON user_enrichment_cards FOR ALL USING (auth.role() = 'service_role');
```

### 3.3 Completion Resolver

New service file `services/gateway/src/services/enrichment/completion-resolver.ts`:

| Card | Table | Check |
|---|---|---|
| E1 | `profiles` | `avatar_url IS NOT NULL` |
| E2 | `profiles` | `bio IS NOT NULL AND char_length(bio) > 50` |
| E3 | `profile_posts` | `count(*) > 0 WHERE user_id = $1` |
| E4 | `profiles` | `interests IS NOT NULL AND array_length(interests, 1) > 0` (new column, §6.3) |
| E5 | `profiles` | `location IS NOT NULL` |
| E6 | `social_connections` | `EXISTS WHERE user_id = $1 AND provider = 'instagram' AND is_active = true AND disconnected_at IS NULL` |
| E7 | `social_connections` | `EXISTS WHERE user_id = $1 AND provider = 'facebook' AND is_active = true AND disconnected_at IS NULL` |
| E8 | `connected_app_settings` | `EXISTS WHERE user_id = $1 AND app_id IN ('google-calendar','outlook-calendar','apple-calendar') AND enabled = true` |
| E9 | `contacts` | `count(*) > 0 WHERE user_id = $1` |
| E10 | `user_device_tokens` | `EXISTS WHERE user_id = $1 AND revoked_at IS NULL AND fcm_token IS NOT NULL` (per `20260225000000_notification_system.sql`, Aurora index `user_device_tokens_active_by_user ... WHERE revoked_at IS NULL`) |
| E11 | `profiles` | `cover_url IS NOT NULL` |

Single batched query (one round-trip) joining all relevant tables, returns `Map<CardType, boolean>`.

### 3.4 Dismissal Mechanism

**Enrichment + Boost (server-side):** `POST /api/v1/enrichment-cards/dismiss` `{ card_type }` upserts `dismissed_at = now()`. GET filters out cards where `dismissed_at + cooldown_days days > now()`. Extends the `user_nudge_state` pattern (`dismissal-tool-repository.ts`).

**Feature cards (client-side):** `localStorage` key `vitana.card.<card_type>.dismissed_at`, 7-day TTL, following `EnableRemindersPrompt` (`DISMISS_KEY` + `DISMISS_TTL_MS` in `src/components/reminders/EnableRemindersPrompt.tsx`). Hook `useCardDismiss(cardType)`.

### 3.5 Priority Algorithm

1. Enrichment — static: E1 → E2 → E3 → E6 → E7 → E8 → E9 → E4 → E5 → E10 → E11
2. Boost — G3 → G2 → G1 (G4 deferred)
3. Feature — per-screen static map in the frontend

## 4. Per-Screen Placement

- **Home:** Top 2 incomplete enrichment cards at positions 1 and 3 in `composeFeed()` output (before existing Vitana Index / Guided Journey cards). Existing cards (VitanaIndexCard, LongevityJourneyCard, InviteFriendCard, DidYouKnowCard, and the match feed item) stay unchanged in order. **Home adds at most 3 new cards**: top-2 incomplete enrichment + top-1 boost (G1–G3). No new feature cards are added to Home in this plan (F3/F4/F6/F9/F11 appear on the other screens only). The cap is enforced in `Home.tsx` before `vitanaCards` is passed to `composeFeed`; `feed-compose.test.ts` gets a case proving the cap and that existing card order is preserved.
- **Profile:** All incomplete enrichment cards as carousel at top; F2, F4, F7; G1, G4; `EnrichmentCardStrip layout="carousel"` + stacked list below.
- **Longevity Journey:** E4, E5; F1, F2, F3, F5, F8; G3; stacked above journey content.
- **Calendar:** E8; F1, F6, F8; stacked below calendar header.
- **Vitana Index:** F3, F4, F6; G3; stacked below index display.
- **Autopilot:** E10; F1, F2, F3, F9; G4; stacked above recommendations.
- **Community / Media Hub:** E3, E6, E7; F5, F7, F10; carousel at top.
- **Make a Post:** E3; F5, F7, F10; stacked above post form.
- **Talk to Vitana:** F1, F2, F3; stacked below assistant interface.

## 5. Component Design

### 5.1 Extending VitanaFeature Union
`VitanaFeature` in `VitanaRecommendationHeader.tsx` grows 5 → 16 values: existing (`vitana-index`, `guided-journey`, `find-a-match`, `invite-friend`, `did-you-know`) + `daily-diary`, `talk-to-vitana`, `autopilot`, `calendar`, `upload-media`, `discover`, `profile-photo`, `profile-setup`, `social-connect`, `import-contacts`, `complete-profile`. `FEATURE_CONFIG` gets Lucide icons + i18n label keys.

### 5.2 Action Button
`src/components/vitana/VitanaCardActionButton.tsx` — shapes round (`h-9 w-9 rounded-full`), pill (`h-8 px-3 rounded-full`), rounded-square (`h-8 w-8 rounded-lg`). Props: `shape`, `icon`, `label?` (hidden on round), `accentClass`, `onClick`. Placed in the `widget` slot of `VitanaRecommendationCard`, replacing each card's custom widget.

### 5.3 Color Theming
Action button bg at full accent (e.g. `bg-violet-600`), card border tint `border-l-2 border-violet-500/30`, headline `text-violet-700 dark:text-violet-400`. Existing Tailwind tokens / CSS vars in `index.css` only.

### 5.4 EnrichmentCardStrip
`src/components/vitana/EnrichmentCardStrip.tsx` — props `screen`, `maxCards` (default 3), `layout` ('carousel'|'stacked'), `className`. Calls `useEnrichmentCards(screen)`; merges server enrichment/boost with client static feature list; carousel via `embla-carousel-react` (existing dep); stacked `gap-2`; renders through `VitanaRecommendationCard`.

### 5.5 useEnrichmentCards
`src/hooks/useEnrichmentCards.ts` — react-query, 5-min cache, optimistic dismiss with rollback.

### 5.6 useCardDismiss
`src/hooks/useCardDismiss.ts` — feature cards: localStorage TTL; enrichment/boost: POST dismiss + invalidate.

## 6. Backend Work

### 6.1 `services/gateway/src/routes/enrichment-cards.ts`
- `GET /api/v1/enrichment-cards?screen=<screen>`
- `POST /api/v1/enrichment-cards/dismiss` `{ card_type }`
Registered where `social-connect.ts` is registered. (No `/complete` endpoint — completion is derived from source tables only; the `completed_at` column is dropped from the table.)

### 6.2 Migration `supabase/migrations/20261012000000_unified_card_system.sql` — DDL from §3.2.

### 6.3 `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS interests TEXT[] DEFAULT '{}';` in the same migration. Values are stable slugs (e.g. `fitness`, `nutrition`), never display text; labels resolve via `t('screens.interests.<slug>')` at render time.

### 6.3b `DATABASE_SCHEMA.md` is updated in the same PR with `user_enrichment_cards` and `profiles.interests` (Always rule 24).

### 6.4 Completion resolver `services/gateway/src/services/enrichment/completion-resolver.ts` (`resolveCompletions(supabase, userId)`) + `completion-resolver-repository.ts` (pattern of `opener-mvp-repository.ts`, `dismissal-tool-repository.ts`).

### 6.5 Boost triggers
- G1: reimplement `useProfileProgress.ts` weighted completion server-side
- G2: `match_notifications` unread count > 0
- G4: DEFERRED (see §2C).
- G3: reuse the streak computation from `diary-streak-celebrator-repository.ts`; no duplicate logic.

### 6.6 FEATURE_TIPS (`services/gateway/src/data/feature-tips.ts`): add `calendar-connect` (deepLink `/calendar`) and `upload-media` (the create-post sheet in media mode), all 11 locales, enforced by `feature-tips.locale-coverage.test.ts`.

### 6.7 `services/gateway/src/data/enrichment-card-tips.ts` — localized title/description for 14 enrichment+boost cards (E1–E11, G1–G3); GET returns these strings. Test `services/gateway/test/data/enrichment-card-tips.locale-coverage.test.ts`.

## 7. Frontend Work

### 7.1 New shared: `VitanaCardActionButton.tsx`, `EnrichmentCardStrip.tsx`.

### 7.2 New cards (14) in `src/components/enrichment/`: UploadPhotoCard, AddBioCard, FirstPostCard, AddInterestsCard, SetLocationCard, ConnectInstagramCard, ConnectFacebookCard, ConnectCalendarCard, ImportContactsCard, EnableNotificationsCard (reuses `pushNotificationManager` from EnableRemindersPrompt), UploadCoverCard, CompleteProfileCard, UnreadMatchesCard, StreakAtRiskCard (EarnVtnaCard deferred). Pattern of `VitanaIndexCard.tsx` / `LongevityJourneyCard.tsx`.

### 7.3 Mounting on 9 screens
| Screen | File (verified) |
|---|---|
| Home | `src/pages/Home.tsx` (vitanaCards array) |
| Profile | `/me/profile` page component (resolve from `src/App.tsx:1480`) |
| Longevity Journey | the component rendering the Guided Journey surface — resolved from `src/App.tsx` before editing; if it is a section of `AutopilotDashboard.tsx`, mount there once (no duplicate strip) |
| Calendar | the `/calendar` page (`src/App.tsx:1183`) |
| Vitana Index | `src/pages/health/VitanaIndexDetail.tsx` |
| Autopilot | `src/pages/AutopilotDashboard.tsx` |
| Community / Media Hub | `src/pages/community/MediaHub.tsx` (`/comm/media-hub`, `src/App.tsx:1260`) |
| Make a Post | within CreateContentPopup / MobileCreatePostSheet |
| Talk to Vitana | `src/pages/community/TalkToVitana.tsx` |

Every deep link in §2 is checked against `src/App.tsx` routes and `src/navigation/registry/screens.json` by a new Vitest (`src/components/vitana/card-deeplinks.test.ts`) that fails on a link to a missing route or a `<Navigate>` redirect.

### 7.4 `src/components/profile/InterestsPicker.tsx` — multi-select chips (~15 fixed categories, max ~10), stores slugs in `profiles.interests` via existing profile update endpoint. 15 labels × 11 locales added to `src/i18n/<locale>/` (DE first, du-form), first pass via `scripts/translate-keys.mjs`, then `i18n-audit-llm.yml`; `npm run i18n:inventory` committed.

### 7.5 Existing cards (`VitanaIndexCard`, `LongevityJourneyCard`, `InviteFriendCard`, `FeatureAnnouncementCard`, `DidYouKnowCard`; "Find a Match" is a `NewsFeedItemCard` match-kind item, not a component — a new `FindAMatchCard` on `VitanaRecommendationCard` is created for non-Home screens only, Home keeps its feed item unchanged) gain `VitanaCardActionButton`, accent border tint, and registration in the strip's screen map.

## 8. Phased Delivery
Phase 1 (steps 1–11): migration; resolver+repo; GET/dismiss endpoints; enrichment-card-tips + locale test; VitanaFeature extension; action button; hooks; 11 enrichment cards; strip; InterestsPicker; mount on Home + Profile.
Phase 2 (12–14): 6 new feature cards in `src/components/feature/` + restyle existing; 2 FEATURE_TIPS; mount on 7 screens.
Phase 3 (15–18): boost resolver; 3 boost cards (G1–G3); wire into strip; full build + test both repos.

## 8b. Governance deliverables
- What's New entry `src/whats-new/entries/profile-enrichment-cards.json` (EN + DE du-form) added in the Phase-1 PR that mounts cards on Home + Profile.
- `docs/validation/<VTID>/staging-tests.json` per deploying PR: read-only Playwright spec on staging that signs in as the test user, opens Home and Profile, asserts the strip renders and `GET /api/v1/enrichment-cards?screen=home` returns 200 JSON — no dismiss POST on staging (write path proven in Jest).
- Gateway-side, translations for `enrichment-card-tips.ts` (14 cards × 2 × 11 locales) produced by the existing LLM translate workflow, then the locale-coverage test.
- `contacts` table presence confirmed read-only on the shared DB before the resolver ships (created by vitana-v1 migration `20251010130129_…`).

## 9. Testing
Backend Jest: `test/services/enrichment/completion-resolver.test.ts`, `test/routes/enrichment-cards.test.ts`, `test/data/enrichment-card-tips.locale-coverage.test.ts`.
Frontend Vitest: `src/components/enrichment/*.test.tsx`, `VitanaCardActionButton.test.tsx`, `EnrichmentCardStrip.test.tsx`, `useEnrichmentCards.test.ts`, `useCardDismiss.test.ts`.
Regression: `test:news-card-features`, `test:news-feed-ranker`, `feature-tips.locale-coverage.test.ts`, `npm run build`.

## 10. Risks
10.1 InterestsPicker new UI — fixed list. 10.2 Notification permission across web/Appilix — reuse EnableRemindersPrompt. 10.3 Card overload — per-screen caps, maxCards. 10.4 330 translated strings — locale tests. 10.5 profiles.interests — IF NOT EXISTS. 10.6 Social OAuth — reuse `GET /api/v1/social-connect/connect/:provider` via ConnectAppPopup. 10.7 Feature-card dismissal is per-device (accepted).

<!-- plan:end -->

---

## Planner responses — Round 1

- **F1 [blocker] social_connections.status** — ACCEPTED. E6/E7 now check `is_active = true AND disconnected_at IS NULL` (§2A, §3.3).
- **F2 [major] interests i18n** — ACCEPTED. Column stores slugs; labels are i18n keys in all 11 locales, DE first, translate + audit workflow, inventory regenerated (§6.3, §7.4).
- **F3 [major] screen paths** — ACCEPTED. §7.3 table replaced with verified paths; Longevity Journey and Profile resolved from `App.tsx` routes before editing, with a rule against duplicate mounts.
- **F4 [major] FindAMatchCard missing** — ACCEPTED. Home keeps the match feed item unchanged; a new `FindAMatchCard` is created only for non-Home screens (§7.5).
- **F5 [major] /me/edit deep links** — ACCEPTED. All changed to `/me/profile#…`. Also fixed from my own route check: `/comm/create-post` does not exist (E3/F10 open the existing create-post sheet), `/settings/connected-apps` is a redirect so E8/E9 point at `/connectors`. New deep-link Vitest guards all of them (also covers F9).
- **F6 [major] What's New** — ACCEPTED. Entry added to the Phase-1 PR (§8b).
- **F7 [major] DATABASE_SCHEMA.md** — ACCEPTED (§6.3b).
- **F8 [major] composeFeed** — ACCEPTED. Home adds at most 3 new cards (2 enrichment + 1 boost); no new feature cards on Home; cap enforced in `Home.tsx`; `feed-compose.test.ts` case added (§4). Also answers Q3.
- **F9 [minor] screen registry** — ACCEPTED via the deep-link test (§7.3).
- **F10 [minor] contacts table** — ACCEPTED as a read-only verification step (§8b).
- **F11 [minor] translation workflow** — ACCEPTED (§8b, §7.4).
- **F12 [minor] POST /complete** — ACCEPTED. Endpoint and `completed_at` column dropped (§6.1, §3.2).
- **Q1 (G3 streak source)** — G3 reuses the streak computation in `services/gateway/src/services/diary-streak-celebrator-repository.ts`; no new table.
- **Q2 (G4 unclaimed rewards)** — No `vtna_rewards` table exists and `claim_capped_reward()` (VTID-04878) credits at claim time, so there is no "unclaimed" state. G4 is DEFERRED out of this plan (tracked in §2C as needing its own plan).
- **Q3 (Home cap)** — see F8.

Also added (planner's own check): a staging-tests.json read-only Playwright suite per deploying PR (Staging Verification Gate rule 47).

## Round 2 — partner disposition
F1–F12 and Q1–Q3 closed. New: F13 [minor] G4 still in §3.5 and `earn-vtna` in §5.1 — ACCEPTED, both removed (union now 16 values).

## Verdict: CONVERGED (2 rounds, no open blocker/major, nothing disputed)
