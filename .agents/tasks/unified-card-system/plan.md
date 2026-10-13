# Unified Card System — Implementation Plan

**Change class:** `standard`
**Scope:** `vitana-v1` (frontend components, hooks, screens), `vitana-platform` (gateway endpoint, migration, feature-tips, completion resolver)

<!-- plan:begin -->

## 1. Summary

90% of Vitana users never upload a profile photo. Engagement features like calendar sync, contact import, and social connects sit unused because there is no in-app nudge guiding users toward them. Meanwhile, Vitana's proactive cards (Vitana Index, Guided Journey, Invite Friend, Find a Match, Did You Know) only appear on the Home feed — users on other screens never see them.

This plan delivers a **Unified Card System**: 26 cards in 3 categories (11 enrichment, 11 feature, 4 engagement boost) rendered through the existing `VitanaRecommendationCard` shell, appearing consistently across 9+ screens. Every card shares the same Vitana identity header (ORB avatar + "Vitana" brand + feature badge), the same 138px fixed height, the same rounded-2xl shape — but each is visually differentiated by a unique color accent and a distinctive action button (round, pill, or rounded-square shape) so users learn to recognize cards by color + button shape at a glance.

Enrichment cards disappear permanently once the user completes the action (server-tracked via existing tables). Dismissed enrichment cards return after a 7-day cooldown (server-tracked, extending the `user_nudge_state` pattern). Feature cards are always present, contextual per screen. Engagement boost cards appear when specific triggers fire.

## 2. Card Catalog

### 2A. Enrichment Cards (11) — disappear when action completed, 7-day dismiss cooldown

| ID | Name | Color (HSL token) | Button Shape | Button Icon + Label | Completion Signal | DeepLink | Screens |
|---|---|---|---|---|---|---|---|
| E1 | Upload Profile Photo | amber 42° `domain-health` | round | 📷 Upload | `profiles.avatar_url IS NOT NULL` | `/me/edit#avatar` | Home (pos 1), Profile |
| E2 | Add Your Bio | orb steel-blue 235° `sys-vitana-card` | pill | ✏️ Write bio | `profiles.bio IS NOT NULL AND length(bio) > 50` | `/me/edit#about` | Home (pos 3), Profile |
| E3 | Make Your First Post | rose-pink 330° `domain-community` | pill | 📝 Post now | `profile_posts count > 0 for user` | `/comm/create-post` | Home, Profile, Community/Media Hub, Make a Post |
| E4 | Add Your Interests | teal 173° `from-emerald-200 to-sky-300` | pill | 🎯 Pick interests | `profiles.interests array non-empty` (new column) | `/me/edit#interests` | Home, Profile, Longevity Journey |
| E5 | Set Your Location | teal 173° `from-emerald-200 to-sky-300` | pill | 📍 Add location | `profiles.location IS NOT NULL` | `/me/edit#location` | Home, Profile, Longevity Journey |
| E6 | Connect Instagram | blue 217° `gradient-follow` | rounded-square | 📸 Connect | `social_connections row for 'instagram' with status='connected'` | social-connect OAuth flow | Home, Profile, Community/Media Hub |
| E7 | Connect Facebook | blue 217° `gradient-follow` | rounded-square | 🔗 Connect | `social_connections row for 'facebook' with status='connected'` | social-connect OAuth flow | Home, Profile, Community/Media Hub |
| E8 | Connect Your Calendar | purple 280° `calendar-primary` | pill | 📅 Connect | `connected_app_settings row for any calendar app (google-calendar, outlook-calendar, apple-calendar)` | `/settings/connected-apps` | Home, Profile, Calendar |
| E9 | Import Your Contacts | sky 199° `sys-vitana-accent` | pill | 👥 Import | `contacts count > 0 for user` | `/settings/connected-apps#contacts` | Home, Profile |
| E10 | Enable Notifications | red-orange 8° `sys-autopilot` | pill | 🔔 Enable | `user_device_tokens row for user with revoked_at IS NULL` (FCM token registered) | notification permission flow | Home, Profile, Autopilot |
| E11 | Upload Cover Photo | amber 42° `domain-health` | round | 🖼️ Upload | `profiles.cover_url IS NOT NULL` | `/me/edit#cover` | Home, Profile |

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
| F10 | Upload Video/Music | rose-pink 330° `domain-community` | round | 🎬 Create | always | `/comm/create-post?type=media` | Community/Media Hub, Make a Post |
| F11 | Discover | purple 265° `domain-discover` | pill | 🧭 Browse | always | `/discover` | Home |

### 2C. Engagement Boost Cards (4) — conditional triggers

| ID | Name | Color (HSL token) | Button Shape | Button Icon + Label | Trigger | DeepLink | Screens |
|---|---|---|---|---|---|---|---|
| G1 | Complete Your Profile | orb steel-blue 235° `sys-vitana-card` | pill | 🚀 Continue setup | `useProfileProgress.completionPercentage < 80` | `/me/edit` | Home, Profile |
| G2 | Unread Matches | blue 217° `gradient-follow` | pill | 💬 See who matched | `unread match notifications > 0` | `/me/matches` | Home |
| G3 | Streak at Risk | amber 42° `domain-health` | round | 🎙 Log today | `diary streak > 3 AND missed yesterday` | `/daily-diary` | Home, Longevity Journey, Vitana Index |
| G4 | Earn VTNA Tokens | teal 173° `from-emerald-200 to-sky-300` | pill | 🪙 Claim reward | `unclaimed milestone reward exists` | `/wallet/rewards` | Home, Profile, Autopilot |

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
    {
      "card_type": "E1",
      "category": "enrichment",
      "completed": false,
      "dismissed_until": null,
      "priority": 1
    },
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

Migration file: `supabase/migrations/YYYYMMDDHHMMSS_unified_card_system.sql`

Naming convention follows existing: `20261012000000_unified_card_system.sql`

```sql
-- Unified Card System: track enrichment/boost card dismissals and completions
CREATE TABLE IF NOT EXISTS user_enrichment_cards (
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_type     TEXT        NOT NULL,  -- e.g. 'E1', 'E2', ..., 'G1', 'G2', ...
  completed_at  TIMESTAMPTZ DEFAULT NULL,
  dismissed_at  TIMESTAMPTZ DEFAULT NULL,
  cooldown_days INT         NOT NULL DEFAULT 7,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_type)
);

-- Index for the endpoint query: all cards for a user
CREATE INDEX idx_user_enrichment_cards_user
  ON user_enrichment_cards (user_id);

-- RLS: users can only see/modify their own rows
ALTER TABLE user_enrichment_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own enrichment cards"
  ON user_enrichment_cards FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own enrichment cards"
  ON user_enrichment_cards FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own enrichment cards"
  ON user_enrichment_cards FOR UPDATE
  USING (auth.uid() = user_id);

-- Service role bypass for the gateway
CREATE POLICY "Service role full access"
  ON user_enrichment_cards FOR ALL
  USING (auth.role() = 'service_role');
```

### 3.3 Completion Resolver

A new service file `services/gateway/src/services/enrichment/completion-resolver.ts` that checks completion state for each enrichment card type against existing tables:

| Card | Table | Check |
|---|---|---|
| E1 | `profiles` | `avatar_url IS NOT NULL` |
| E2 | `profiles` | `bio IS NOT NULL AND char_length(bio) > 50` |
| E3 | `profile_posts` | `count(*) > 0 WHERE user_id = $1` |
| E4 | `profiles` | `interests IS NOT NULL AND array_length(interests, 1) > 0` (new `interests TEXT[]` column on profiles — see §6.3) |
| E5 | `profiles` | `location IS NOT NULL` |
| E6 | `social_connections` | `EXISTS WHERE user_id = $1 AND provider = 'instagram' AND status = 'connected'` |
| E7 | `social_connections` | `EXISTS WHERE user_id = $1 AND provider = 'facebook' AND status = 'connected'` |
| E8 | `connected_app_settings` | `EXISTS WHERE user_id = $1 AND app_id IN ('google-calendar', 'outlook-calendar', 'apple-calendar') AND enabled = true` |
| E9 | `contacts` | `count(*) > 0 WHERE user_id = $1` |
| E10 | `user_device_tokens` | `EXISTS WHERE user_id = $1 AND revoked_at IS NULL AND fcm_token IS NOT NULL` (confirmed: table is `user_device_tokens` with `fcm_token` column and `revoked_at` soft-delete, per `20260225000000_notification_system.sql` and Aurora index `user_device_tokens_active_by_user ... WHERE revoked_at IS NULL`) |
| E11 | `profiles` | `cover_url IS NOT NULL` |

The resolver runs a single batched query (one round-trip) joining all relevant tables, returns a `Map<CardType, boolean>` of completion states.

### 3.4 Dismissal Mechanism

**Enrichment + Boost cards (server-side):** New endpoint `POST /api/v1/enrichment-cards/dismiss` accepts `{ card_type: string }`. Upserts `user_enrichment_cards` row with `dismissed_at = now()`. The GET endpoint filters out cards where `dismissed_at IS NOT NULL AND dismissed_at + (cooldown_days * interval '1 day') > now()`. This extends the `user_nudge_state` pattern from the guide pacer (see `dismissal-tool-repository.ts`).

**Feature cards (client-side):** Feature cards use `localStorage` with a `vitana.card.<card_type>.dismissed_at` key and 7-day TTL, following the `EnableRemindersPrompt` pattern (`DISMISS_KEY` + `DISMISS_TTL_MS` in `src/components/reminders/EnableRemindersPrompt.tsx`). A new hook `useCardDismiss(cardType)` encapsulates this.

### 3.5 Priority Algorithm

The enrichment-cards endpoint sorts cards by:

1. **Enrichment cards** — static engagement-value order: E1 (photo) → E2 (bio) → E3 (first post) → E6 (Instagram) → E7 (Facebook) → E8 (calendar) → E9 (contacts) → E4 (interests) → E5 (location) → E10 (notifications) → E11 (cover photo)
2. **Boost cards** — trigger urgency: G3 (streak at risk, time-sensitive) → G2 (unread matches, social) → G1 (profile completion, persistent) → G4 (VTNA reward, reward)
3. **Feature cards** — screen-relevance order defined per screen in a static map (no server call needed; the frontend holds the feature card order per screen)

## 4. Per-Screen Placement

### Home Feed
- **Enrichment:** Top 2 incomplete enrichment cards at positions 1 and 3 in `composeFeed()` output (inserted before the existing Vitana Index / Guided Journey cards)
- **Feature:** Existing cards (VitanaIndexCard, LongevityJourneyCard, InviteFriendCard, FindAMatchCard) remain in their current composeFeed positions; add F3 (Daily Diary), F4 (Talk to Vitana), F6 (Autopilot), F8 (Did You Know — already present via DidYouKnowCard), F9 (Calendar), F11 (Discover) to the vitanaCards array
- **Boost:** G1 (profile < 80%), G2 (unread matches), G3 (streak at risk), G4 (unclaimed reward) — injected after enrichment cards in composeFeed
- **Max visible:** 2 enrichment + 2 boost + 6 feature = 10 Vitana cards max interleaved with posts
- **composeFeed() changes:** The `vitanaCards` array in `Home.tsx` grows from 4–5 entries to ~12. The `composeFeed` function itself needs no structural change — it already handles arbitrary-length vitanaCards arrays. The ordering within the array determines display order.

### Profile Screen
- **Enrichment:** All incomplete enrichment cards as a horizontal carousel at the top of the profile view (E1–E11, ordered by priority)
- **Feature:** F2 (Vitana Index), F4 (Talk to Vitana), F7 (Invite Friend)
- **Boost:** G1 (Complete Your Profile), G4 (Earn VTNA)
- **Layout:** `EnrichmentCardStrip` component with `layout="carousel"` at the top of the profile screen, feature/boost cards as a stacked list below

### Longevity Journey
- **Enrichment:** E4 (Interests), E5 (Location)
- **Feature:** F1 (Guided Journey), F2 (Vitana Index), F3 (Daily Diary), F5 (Find a Match), F8 (Did You Know)
- **Boost:** G3 (Streak at Risk)
- **Layout:** `EnrichmentCardStrip` with `layout="stacked"` above the journey content

### Calendar
- **Enrichment:** E8 (Connect Calendar)
- **Feature:** F1 (Guided Journey), F6 (Autopilot), F8 (Did You Know)
- **Boost:** none
- **Layout:** `EnrichmentCardStrip` with `layout="stacked"` below the calendar header

### Vitana Index (Health)
- **Enrichment:** none
- **Feature:** F3 (Daily Diary), F4 (Talk to Vitana), F6 (Autopilot)
- **Boost:** G3 (Streak at Risk)
- **Layout:** `EnrichmentCardStrip` with `layout="stacked"` below the index display

### Autopilot
- **Enrichment:** E10 (Enable Notifications)
- **Feature:** F1 (Guided Journey), F2 (Vitana Index), F3 (Daily Diary), F9 (Calendar)
- **Boost:** G4 (Earn VTNA)
- **Layout:** `EnrichmentCardStrip` with `layout="stacked"` above the recommendations list

### Community / Media Hub
- **Enrichment:** E3 (First Post), E6 (Instagram), E7 (Facebook)
- **Feature:** F5 (Find a Match), F7 (Invite Friend), F10 (Upload Video/Music)
- **Boost:** none
- **Layout:** `EnrichmentCardStrip` with `layout="carousel"` at the top

### Make a Post
- **Enrichment:** E3 (First Post)
- **Feature:** F5 (Find a Match), F7 (Invite Friend), F10 (Upload Video/Music)
- **Boost:** none
- **Layout:** `EnrichmentCardStrip` with `layout="stacked"` above the post form

### Talk to Vitana
- **Enrichment:** none
- **Feature:** F1 (Guided Journey), F2 (Vitana Index), F3 (Daily Diary)
- **Boost:** none
- **Layout:** `EnrichmentCardStrip` with `layout="stacked"` below the assistant interface

## 5. Component Design

### 5.1 Extending VitanaFeature Union

The `VitanaFeature` type in `VitanaRecommendationHeader.tsx` grows from 5 to 20 values:

```typescript
export type VitanaFeature =
  // Existing (5)
  | 'vitana-index' | 'guided-journey' | 'find-a-match' | 'invite-friend' | 'did-you-know'
  // New feature cards (6)
  | 'daily-diary' | 'talk-to-vitana' | 'autopilot' | 'calendar' | 'upload-media' | 'discover'
  // Enrichment cards (4 unique badges — many cards share a badge)
  | 'profile-photo' | 'profile-setup' | 'social-connect' | 'import-contacts'
  // Boost cards (2 unique badges)
  | 'complete-profile' | 'earn-vtna';
```

The `FEATURE_CONFIG` record gets corresponding entries with appropriate Lucide icons and i18n label keys. Cards sharing a color domain can share a badge (e.g., E6 and E7 both use `social-connect`).

### 5.2 Action Button Component

New file: `src/components/vitana/VitanaCardActionButton.tsx`

Three shape variants, all using the card's accent color:

```
| Shape | CSS | Use Cases |
|---|---|---|
| round | h-9 w-9 rounded-full | Daily Diary mic, Talk to Vitana orb, Upload Photo camera, Upload Media camera, Cover Photo |
| pill | h-8 px-3 rounded-full | Guided Journey Play, Vitana Index Check, Autopilot Open, most enrichment/boost |
| rounded-square | h-8 w-8 rounded-lg | Invite Friend share, Connect Instagram, Connect Facebook |
```

Props: `shape: 'round' | 'pill' | 'rounded-square'`, `icon: ReactNode`, `label?: string` (hidden on round, visible on pill/rounded-square), `accentClass: string` (bg color class), `onClick: () => void`.

The button is placed in the `widget` slot of `VitanaRecommendationCard` (the right column), replacing each card's custom widget. This means the action button IS the widget — users tap it to start the action, or tap elsewhere on the card to navigate to the deeplink.

### 5.3 Color Theming

Each card applies its accent color through:
1. **Action button background** — the accent color at full opacity (e.g., `bg-violet-600` for Guided Journey)
2. **Card border tint** — the accent color at 30% opacity as a subtle left border or top border (e.g., `border-l-2 border-violet-500/30`)
3. **Headline text** — the accent color at dark mode-appropriate level (e.g., `text-violet-700 dark:text-violet-400`)

All colors use existing Tailwind tokens or CSS custom properties already defined in `index.css`. No new CSS variables needed.

### 5.4 EnrichmentCardStrip Component

New file: `src/components/vitana/EnrichmentCardStrip.tsx`

```typescript
interface EnrichmentCardStripProps {
  screen: ScreenName;       // 'home' | 'profile' | 'longevity-journey' | 'calendar' | ...
  maxCards?: number;         // default 3
  layout?: 'carousel' | 'stacked';  // carousel for Profile/Community, stacked for others
  className?: string;
}
```

Internally:
1. Calls `useEnrichmentCards(screen)` hook which fetches from `GET /api/v1/enrichment-cards?screen=<screen>`
2. Merges server enrichment/boost results with client-side feature card list (static per screen)
3. Renders cards in the specified layout
4. Carousel layout uses `embla-carousel-react` (already a dependency in vitana-v1's package.json)
5. Stacked layout renders cards vertically with `gap-2`
6. Each card renders through the shared `VitanaRecommendationCard` shell

### 5.5 useEnrichmentCards Hook

New file: `src/hooks/useEnrichmentCards.ts`

Uses `@tanstack/react-query` (already in deps) to fetch from the gateway endpoint. Caches for 5 minutes. Returns `{ cards, isLoading, refetch }`. The hook also manages optimistic updates for dismiss actions (immediately removes the card from the list, rolls back on server error).

### 5.6 useCardDismiss Hook

New file: `src/hooks/useCardDismiss.ts`

For feature cards (client-side only): reads/writes `localStorage` with `vitana.card.<type>.dismissed_at` key, checks 7-day TTL. Returns `{ isDismissed, dismiss }`.

For enrichment/boost cards: calls `POST /api/v1/enrichment-cards/dismiss` and invalidates the react-query cache.

## 6. Backend Work

### 6.1 New Endpoint File

**File:** `services/gateway/src/routes/enrichment-cards.ts`

- `GET /api/v1/enrichment-cards?screen=<screen>` — authenticated, calls completion resolver + reads user_enrichment_cards, returns prioritized card list
- `POST /api/v1/enrichment-cards/dismiss` — authenticated, body `{ card_type: string }`, upserts dismissal row
- `POST /api/v1/enrichment-cards/complete` — authenticated, body `{ card_type: string }`, marks as completed (called by client when the action succeeds, e.g., after photo upload). Note: the GET endpoint also auto-detects completions by checking source tables, so this is a belt-and-suspenders optimization.

Register the router in the gateway's main Express app (the same place `social-connect.ts` is registered).

### 6.2 Migration File

**File:** `supabase/migrations/20261012000000_unified_card_system.sql`

Contents: the DDL from §3.2 above.

### 6.3 Profile Interests Column

The `profiles` table currently has no `interests` column. Add one via migration:

```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS interests TEXT[] DEFAULT '{}';
```

This goes in the same migration file. The completion resolver for E4 checks `array_length(interests, 1) > 0`.

### 6.4 Completion Resolver Service

**File:** `services/gateway/src/services/enrichment/completion-resolver.ts`

A single function `resolveCompletions(supabase, userId): Promise<Map<string, boolean>>` that runs one batched query joining profiles, profile_posts (count), social_connections, connected_app_settings, contacts (count), and user_device_tokens. Returns completion state for all 11 enrichment cards + the 4 boost card triggers.

**File:** `services/gateway/src/services/enrichment/completion-resolver-repository.ts`

Repository file (following the `-repository.ts` pattern from `opener-mvp-repository.ts` and `dismissal-tool-repository.ts`) with isolated Supabase queries for testability.

### 6.5 Boost Trigger Resolver

Part of the same service. Checks:
- G1: calls `useProfileProgress` logic server-side (reimplement the weighted completion check from `useProfileProgress.ts` — same weights, same fields)
- G2: queries `match_notifications` for unread count > 0
- G3: queries diary entries for streak > 3 and no entry yesterday
- G4: queries `vtna_rewards` for unclaimed milestone rewards (joins against `VTNA_REWARD_RULES` from `vtna-reward-rules.ts`)

### 6.6 FEATURE_TIPS Extension

**File:** `services/gateway/src/data/feature-tips.ts`

Add entries for the 6 new feature card types that don't already have tips: `daily-diary` (already exists), `autopilot` (already exists), `assistant-voice` (already exists as 'Talk to Vitana'), `discover` (already exists), `calendar` (needs new entry), `upload-media` (needs new entry).

New FEATURE_TIPS entries needed:

1. `calendar-connect` — title/description for the calendar card, deepLink `/calendar`
2. `upload-media` — title/description for upload video/music, deepLink `/comm/create-post?type=media`

Each new entry must have all 11 gateway locales (en, de, es, sr, fr, pt, ru, pl, zh, ar, tr) with genuinely translated content (not copies of English). The `feature-tips.locale-coverage.test.ts` test will enforce this.

### 6.7 Enrichment Card Tips Data

**File:** `services/gateway/src/data/enrichment-card-tips.ts`

New data file (same structure as `feature-tips.ts`) with localized title/description for all 11 enrichment cards + 4 boost cards. The GET endpoint returns these strings so the frontend doesn't need to duplicate them.

Companion test: `services/gateway/test/data/enrichment-card-tips.locale-coverage.test.ts` — same pattern as `feature-tips.locale-coverage.test.ts`.

## 7. Frontend Work

### 7.1 New Shared Components

| File | Description |
|---|---|
| `src/components/vitana/VitanaCardActionButton.tsx` | 3-shape action button (round/pill/rounded-square) |
| `src/components/vitana/EnrichmentCardStrip.tsx` | Card strip renderer (carousel/stacked) mounted on every screen |

### 7.2 New Card Components (15)

Each new card component follows the exact pattern of `VitanaIndexCard.tsx` and `LongevityJourneyCard.tsx`: wraps `VitanaRecommendationCard`, provides feature badge, eyebrow, headline, subtext, and the new `VitanaCardActionButton` as the widget.

**Enrichment cards (11):**

| File | Card |
|---|---|
| `src/components/enrichment/UploadPhotoCard.tsx` | E1 — opens camera/gallery picker for avatar |
| `src/components/enrichment/AddBioCard.tsx` | E2 — navigates to profile editor about section |
| `src/components/enrichment/FirstPostCard.tsx` | E3 — opens MobileCreatePostSheet or CreateContentPopup |
| `src/components/enrichment/AddInterestsCard.tsx` | E4 — opens new interests picker (see §7.4) |
| `src/components/enrichment/SetLocationCard.tsx` | E5 — navigates to profile editor location section |
| `src/components/enrichment/ConnectInstagramCard.tsx` | E6 — triggers Instagram OAuth via existing social-connect flow |
| `src/components/enrichment/ConnectFacebookCard.tsx` | E7 — triggers Facebook OAuth via existing social-connect flow |
| `src/components/enrichment/ConnectCalendarCard.tsx` | E8 — navigates to connected apps hub |
| `src/components/enrichment/ImportContactsCard.tsx` | E9 — navigates to connected apps contacts section |
| `src/components/enrichment/EnableNotificationsCard.tsx` | E10 — triggers notification permission (reuses `pushNotificationManager` from EnableRemindersPrompt) |
| `src/components/enrichment/UploadCoverCard.tsx` | E11 — opens camera/gallery picker for cover photo |

**Boost cards (4):**

| File | Card |
|---|---|
| `src/components/enrichment/CompleteProfileCard.tsx` | G1 — uses `useProfileProgress`, shows completion % |
| `src/components/enrichment/UnreadMatchesCard.tsx` | G2 — shows match count, navigates to matches |
| `src/components/enrichment/StreakAtRiskCard.tsx` | G3 — shows streak count, opens daily diary |
| `src/components/enrichment/EarnVtnaCard.tsx` | G4 — shows reward amount, navigates to wallet |

### 7.3 Mounting EnrichmentCardStrip on 9 Screens

| Screen | File to Modify | Mount Location |
|---|---|---|
| Home | `src/pages/Home.tsx` | Enrichment cards added to the `vitanaCards` array for `composeFeed` interleaving |
| Profile | `src/pages/Profile.tsx` (confirmed path) | `<EnrichmentCardStrip screen="profile" layout="carousel" />` at top of profile view |
| Longevity Journey | `src/pages/autopilot/GuidedJourney.tsx` (or equivalent) | `<EnrichmentCardStrip screen="longevity-journey" />` above journey content |
| Calendar | `src/pages/calendar/Calendar.tsx` (or equivalent) | `<EnrichmentCardStrip screen="calendar" />` below header |
| Vitana Index | `src/pages/health/VitanaIndex.tsx` (or equivalent) | `<EnrichmentCardStrip screen="vitana-index" />` below index display |
| Autopilot | `src/pages/autopilot/Autopilot.tsx` (or equivalent) | `<EnrichmentCardStrip screen="autopilot" />` above recommendations |
| Community | `src/pages/comm/Community.tsx` (or equivalent) | `<EnrichmentCardStrip screen="community" layout="carousel" />` at top |
| Make a Post | Mount within CreateContentPopup or MobileCreatePostSheet | `<EnrichmentCardStrip screen="make-a-post" maxCards={2} />` above form |
| Talk to Vitana | `src/pages/assistant/Assistant.tsx` (or equivalent) | `<EnrichmentCardStrip screen="talk-to-vitana" />` below assistant interface |

Note: the Home screen is special — it doesn't use `EnrichmentCardStrip` directly; instead, enrichment cards are added to the `vitanaCards` array in `Home.tsx` so they participate in `composeFeed()`'s interleaving pattern.

### 7.4 Interests/Goals Picker (New UI)

New component: `src/components/profile/InterestsPicker.tsx`

A sheet/dialog that presents a grid of interest/goal categories (health, fitness, nutrition, mindfulness, longevity, biohacking, social, career, etc.) as tappable chips. Selected interests are written to the new `profiles.interests` column via the existing profile update endpoint. This is the target of E4's action button.

Design: follows the chip/pill selection pattern already used in the onboarding flow. Multi-select, max ~10 interests.

### 7.5 Existing Card Refactoring

The 5 existing card components (`VitanaIndexCard`, `LongevityJourneyCard`, `InviteFriendCard`, `FeatureAnnouncementCard`, `DidYouKnowCard`) keep their current implementations but gain:
1. The new `VitanaCardActionButton` in their widget slot (replacing the current custom widgets with the standardized button shape)
2. The accent color border tint
3. Registration in the `EnrichmentCardStrip` screen map so they appear on screens beyond Home

`VitanaIndexCard` and `LongevityJourneyCard` already have action buttons (the "View Index" arrow and the "Play episode" button) — these get restyled to use `VitanaCardActionButton` for visual consistency but keep their existing behavior.

## 8. Phased Delivery

### Phase 1: Enrichment Infrastructure + Home/Profile (Core)

**Goal:** Ship the enrichment card system with 11 enrichment cards on Home + Profile screens. This directly addresses the 90% no-photo problem.

- [x] 1. Create migration `20261012000000_unified_card_system.sql` with `user_enrichment_cards` table DDL and `profiles.interests` column addition.
      Files: `supabase/migrations/20261012000000_unified_card_system.sql`
      Verify: migration SQL is syntactically valid (parse check).

- [x] 2. Create completion resolver service + repository with batched query checking all 11 enrichment completion signals.
      Files: `services/gateway/src/services/enrichment/completion-resolver.ts`, `services/gateway/src/services/enrichment/completion-resolver-repository.ts`
      Verify: `cd services/gateway && npx jest test/services/enrichment/completion-resolver` — new unit tests pass.

- [x] 3. Create the `GET /api/v1/enrichment-cards` and `POST /api/v1/enrichment-cards/dismiss` endpoints. Register router in Express app.
      Files: `services/gateway/src/routes/enrichment-cards.ts`, update `services/gateway/src/index.ts` (or route registration file)
      Verify: `cd services/gateway && npx jest test/routes/enrichment-cards` — endpoint tests pass.

- [x] 4. Create `enrichment-card-tips.ts` data file with localized title/description for all 15 enrichment+boost cards across all 11 gateway locales. Create companion locale-coverage test.
      Files: `services/gateway/src/data/enrichment-card-tips.ts`, `services/gateway/test/data/enrichment-card-tips.locale-coverage.test.ts`
      Verify: `cd services/gateway && npx jest test/data/enrichment-card-tips.locale-coverage` — locale coverage test passes.

- [x] 5. Extend `VitanaFeature` union type in `VitanaRecommendationHeader.tsx` with 15 new keys. Add `FEATURE_CONFIG` entries with Lucide icons and i18n label keys.
      Files: `src/components/vitana/VitanaRecommendationHeader.tsx`
      Verify: `cd vitana-v1 && npx vitest run src/components/vitana` — existing tests pass, TypeScript compiles.

- [x] 6. Create `VitanaCardActionButton` component with round/pill/rounded-square variants.
      Files: `src/components/vitana/VitanaCardActionButton.tsx`
      Verify: `cd vitana-v1 && npx vitest run` — builds clean, no type errors.

- [x] 7. Create `useEnrichmentCards` and `useCardDismiss` hooks.
      Files: `src/hooks/useEnrichmentCards.ts`, `src/hooks/useCardDismiss.ts`
      Verify: `cd vitana-v1 && npx vitest run src/hooks` — hook tests pass.

- [x] 8. Create all 11 enrichment card components (E1–E11).
      Files: `src/components/enrichment/UploadPhotoCard.tsx`, `AddBioCard.tsx`, `FirstPostCard.tsx`, `AddInterestsCard.tsx`, `SetLocationCard.tsx`, `ConnectInstagramCard.tsx`, `ConnectFacebookCard.tsx`, `ConnectCalendarCard.tsx`, `ImportContactsCard.tsx`, `EnableNotificationsCard.tsx`, `UploadCoverCard.tsx`
      Verify: `cd vitana-v1 && npx vitest run src/components/enrichment` — component tests pass.

- [x] 9. Create `EnrichmentCardStrip` component with carousel/stacked layouts.
      Files: `src/components/vitana/EnrichmentCardStrip.tsx`
      Verify: `cd vitana-v1 && npx vitest run src/components/vitana/EnrichmentCardStrip` — renders correctly.

- [x] 10. Create `InterestsPicker` sheet component for E4's action target.
      Files: `src/components/profile/InterestsPicker.tsx`
      Verify: `cd vitana-v1 && npx vitest run src/components/profile/InterestsPicker` — picker tests pass.

- [x] 11. Mount enrichment cards on Home (add to `vitanaCards` array in Home.tsx for composeFeed interleaving) and Profile (add `EnrichmentCardStrip` carousel at top).
      Files: `src/pages/Home.tsx`, `src/pages/Profile.tsx`
      Verify: `cd vitana-v1 && npm run build` — clean production build. `npx vitest run` — all tests pass.

### Phase 2: Feature Cards on All Screens

**Goal:** Ship 11 feature cards across all 9 screens so every screen shows the unified Vitana card family.

- [x] 12. Create 6 new feature card components (F3 Daily Diary, F4 Talk to Vitana, F6 Autopilot, F9 Calendar, F10 Upload Media, F11 Discover). Existing cards (F1 Guided Journey = LongevityJourneyCard, F2 Vitana Index = VitanaIndexCard, F5 Find a Match, F7 Invite Friend = InviteFriendCard, F8 Did You Know = DidYouKnowCard) already exist — restyle their widgets to use `VitanaCardActionButton`.
      Files: `src/components/feature/DailyDiaryCard.tsx`, `TalkToVitanaCard.tsx`, `AutopilotCard.tsx`, `CalendarCard.tsx`, `UploadMediaCard.tsx`, `DiscoverCard.tsx`; modify `VitanaIndexCard.tsx`, `LongevityJourneyCard.tsx`, `InviteFriendCard.tsx`
      Verify: `cd vitana-v1 && npx vitest run src/components/feature src/components/home` — all card tests pass.

- [x] 13. Add 2 new FEATURE_TIPS entries (`calendar-connect`, `upload-media`) with all 11 locales.
      Files: `services/gateway/src/data/feature-tips.ts`
      Verify: `cd services/gateway && npx jest test/data/feature-tips.locale-coverage` — passes.

- [x] 14. Mount `EnrichmentCardStrip` on remaining 7 screens (Longevity Journey, Calendar, Vitana Index, Autopilot, Community, Make a Post, Talk to Vitana) with per-screen card lists and appropriate layouts.
      Files: Modify 7 screen page files (see §7.3 table)
      Verify: `cd vitana-v1 && npm run build` — clean production build. `npx vitest run` — all tests pass.

### Phase 3: Engagement Boost Cards

**Goal:** Ship 4 conditional boost cards with trigger system and VTNA integration.

- [x] 15. Add boost trigger resolver to the completion-resolver service (G1 profile completion, G2 unread matches, G3 streak at risk, G4 unclaimed reward). _Done for G1–G3 (vitana-platform #4095); G4 out of scope (owner 2026-10-13)._
      Files: update `services/gateway/src/services/enrichment/completion-resolver.ts`
      Verify: `cd services/gateway && npx jest test/services/enrichment` — trigger tests pass.

- [x] 16. Create 4 boost card components (G1–G4). _G1–G3 built (vitana-v1 #1371); G4 out of scope._
      Files: `src/components/enrichment/CompleteProfileCard.tsx`, `UnreadMatchesCard.tsx`, `StreakAtRiskCard.tsx`, `EarnVtnaCard.tsx`
      Verify: `cd vitana-v1 && npx vitest run src/components/enrichment` — all boost card tests pass.

- [x] 17. Wire boost cards into `EnrichmentCardStrip` rendering pipeline across all screens (see §4 for per-screen placement). Update `useEnrichmentCards` to include boost card data from the endpoint.
      Files: update `src/components/vitana/EnrichmentCardStrip.tsx`, `src/hooks/useEnrichmentCards.ts`
      Verify: `cd vitana-v1 && npm run build` — clean build. `npx vitest run` — full test suite passes.

- [x] 18. End-to-end verification: build both repos, run full test suites.
      Verify: `cd vitana-v1 && npm run build && npx vitest run` and `cd services/gateway && npm run build && npx jest` — both clean.

## 9. Testing

### 9.1 Backend Tests (Jest — `services/gateway`)

| Test File | What It Covers |
|---|---|
| `test/services/enrichment/completion-resolver.test.ts` | Unit tests for each of the 11 completion checks + 4 boost triggers. Mock Supabase calls (following `opener-mvp-repository.test.ts` pattern). |
| `test/routes/enrichment-cards.test.ts` | HTTP tests for GET and POST endpoints. Mock auth, mock resolver. Verify response shapes, filtering by screen, dismissal cooldown logic, completed card exclusion. |
| `test/data/enrichment-card-tips.locale-coverage.test.ts` | Same pattern as `feature-tips.locale-coverage.test.ts`: every card tip has title+description for all 11 gateway locales, no English copies. |

### 9.2 Frontend Tests (Vitest — `vitana-v1`)

| Test Pattern | What It Covers |
|---|---|
| `src/components/enrichment/*.test.tsx` | Each enrichment/boost card renders correctly, fires correct action on button click, calls dismiss on X click. Follow `VitanaIndexCard` testing patterns. |
| `src/components/vitana/VitanaCardActionButton.test.tsx` | All 3 shape variants render correct CSS classes. Click handler fires. Accessibility (role, aria-label). |
| `src/components/vitana/EnrichmentCardStrip.test.tsx` | Renders correct cards for each screen. Carousel vs stacked layout. Respects maxCards. Loading state. Empty state (all completed). |
| `src/hooks/useEnrichmentCards.test.ts` | Fetches from endpoint, caches, handles errors, optimistic dismiss. |
| `src/hooks/useCardDismiss.test.ts` | localStorage read/write, TTL expiry, server dismiss call. |

### 9.3 Regression Guards

- Run existing `test:news-card-features` regression script after composeFeed changes
- Run existing `test:news-feed-ranker` to verify feed ordering is not broken
- Run `feature-tips.locale-coverage.test.ts` after any FEATURE_TIPS changes
- Run full `npm run build` in vitana-v1 to catch any TypeScript errors from VitanaFeature union extension

## 10. Risks and Open Questions

### 10.1 Interests Picker Complexity
The `InterestsPicker` is new UI with no existing pattern to follow for the interest categories themselves. **Mitigation:** Use a fixed list of ~15 longevity/wellness interest categories (not user-generated). The categories can be expanded later without schema changes since `interests` is a `TEXT[]` column.

### 10.2 Notification Permission UX Across Platforms
E10 (Enable Notifications) must handle: web browsers (Notification API), Appilix WebView (no Notification API), and various mobile browsers. **Mitigation:** Reuse the exact logic from `EnableRemindersPrompt.tsx` which already handles all these cases including Appilix detection. The enrichment card just wraps that same flow in the Vitana card shell.

### 10.3 Card Overload Risk
26 cards across 9 screens risks overwhelming users. **Mitigation:** Each screen shows a capped subset (see §4), enrichment cards disappear as users complete them, the `maxCards` prop on `EnrichmentCardStrip` limits visible count, and the priority algorithm ensures highest-value cards surface first.

### 10.4 Locale Coverage for 15 New Card Tips
15 new cards × 2 strings (title + description) × 11 locales = 330 new translated strings. **Mitigation:** The locale-coverage test (following `feature-tips.locale-coverage.test.ts` pattern) will fail the build if any locale is missing. Initial translations can use the same LLM-assisted translation workflow used for the existing FEATURE_TIPS.

### 10.5 profiles.interests Column
Adding a new column to the `profiles` table requires coordination with any in-flight migrations. **Mitigation:** The `IF NOT EXISTS` guard on the ALTER TABLE makes it idempotent. The column is nullable with a default of `'{}'` so no existing data is affected.

### 10.6 Social Connect OAuth Flows
E6 and E7 need to trigger Instagram/Facebook OAuth from within a card tap. **Mitigation:** The full OAuth flow already exists in `social-connect.ts` routes. The card components just need to open the OAuth URL (via `GET /api/v1/social-connect/connect/:provider`), which the existing `ConnectAppPopup` component already does — the enrichment cards reuse that flow.

### 10.7 Feature Card Dismissal Consistency
Feature cards use localStorage (client-side) while enrichment cards use server-side tracking. A user switching devices will see feature cards re-appear. **Accepted trade-off:** Feature cards are always-present by design and dismissal is just a convenience — they're not actionable tasks that should stay dismissed permanently. Enrichment cards (the ones users complete) are server-tracked for cross-device consistency.

<!-- plan:end -->
