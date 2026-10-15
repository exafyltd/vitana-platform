# Design — New-member welcome experience

Author: kiro (session kiro-202610150924-9ecd). Drafted 2026-10-15.
Status: drafted — awaiting sparring + Gate 1. No VTID allocated, no code written.

Spans both repos (spec lives in `vitana-platform` per collaboration §2):
- `vitana-platform` — gateway welcome-sender service, config, claim RPC migration,
  scheduled tick wiring, CI simulation.
- `vitana-v1` — new-member card opt-in + inline greeting composer, suggestion fetch,
  opt-in column + welcome-post backing migration, grouped notification.

Design principle (from VOA §4.1): **one brain, many mouths** — a gateway coach decides;
existing channels render. We reuse the VOA touch ledger and the gateway tick; we do NOT
add a DB trigger for the staggered sends (sparring F6: a `user_tenants` trigger can't see
the gateway allowlist and would message every signup from day one).

---

## Part A — Three private team welcome messages

> **Owner decision 2026-10-15:** no per-sender wording/consent approval; the three welcomes are sent automatically. Where this
> section says the senders approve their wording, that step is removed.

### A.1 Senders config (configurable, not hardcoded)
New TS config module `services/gateway/src/services/welcome-team/config.ts` (same shape as
`companion/config.ts`): mode (`disabled-on-staging | off | shadow | staff | live`), the
`COMPANION_SEND_ENABLED`-style explicit send switch, and a `senders` array:

```
WELCOME_SENDER_MARIIA_ID = 67c971fc-48f3-49ce-aaa8-cddb6fa9e63a   # @mariia04
WELCOME_SENDER_JOVANA_ID = c7d3260d-8311-4a0b-ab1c-53928a37caec   # @jovana4
WELCOME_SENDER_ALEX_ID   = 0adc6ff6-acb0-4dca-99d0-295211a40e3e   # @dragan1 (real human)
WELCOME_STAGGER_DAYS_MARIIA = 0   # at registration
WELCOME_STAGGER_DAYS_JOVANA = 1
WELCOME_STAGGER_DAYS_ALEX   = 2
```
Each sender has `{ slug, userIdEnv, staggerDays, intentKey, allowAiIdentity:false }`.
IDs re-verified read-only at pre-flight before any live send (VOA rule); the Mariia
account's display_name discrepancy (requirements table) is resolved then.

### A.2 Message content — composition vs. catalog (OPEN sparring question S1)
Two conventions collide and the partner should rule:
- **Option A (catalog, matches VOA §4.5.5):** `tt()` catalog entries per sender per locale,
  du-form. VOA treats a welcome *from a person* as a written message, so rule 41 does not
  apply — the catalog rule does. Pro: reviewable, translator-owned, deterministic, Mariia/
  Jovana/Alex can approve exact wording once. Con: fixed wording, three senders × 11 locales.
- **Option B (model-composed, matches `composer.ts`):** English intent → Bedrock →
  `buildLocalizedSystemPromptForLang(intent, recipientLocale)` → validation. Pro: warm,
  natural, varied; honours "message-generation conventions". Con: a human sender's "voice"
  is model-generated; needs guardrails and the senders approve the *intent*, not the words.

Seed wording for Option A is drafted in `content-welcome-seed.md` (en+de in full,
EN source + intent notes for the other 9 locales), for the sparring partner and the three
senders to approve.

**Recommendation:** Option A (catalog) for the three team welcomes — they are messages
*from named people* who approve their wording, exactly VOA's decided treatment; keep model
composition for the *community greeting suggestions* (Part B), which are drafts a human
edits. This keeps each path on its established convention. The intents in requirements §1.4
become the catalog seed wording. Partner to confirm.

Recipient locale resolved by `getUserLocale(recipientId)` (server-locale.ts); du-form.
Alex's entry: friendly human tech-support intro, no AI claim, no "I'll reply immediately".

### A.3 Send-once idempotency — one claim RPC, three sender rows
New migration (vitana-platform) `welcome_team_claims`:
```sql
CREATE TABLE public.welcome_team_claims (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_slug text NOT NULL,            -- 'mariia' | 'jovana' | 'alex'
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    int  NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sender_slug)
);
-- RLS on, zero policies (service_role only).
```
RPC `claim_welcome_message(p_user_id, p_sender_slug)` — SECURITY DEFINER, service_role
only, same contract as `claim_onboarding_touch`: INSERT ON CONFLICT DO NOTHING → claimed;
a `failed`/attempts=1 row may be reclaimed once; `sent` → `already_sent`; `pending` →
`in_flight`. `finish_welcome_message(p_user_id, p_sender_slug, p_status)` moves a pending
row to sent|failed. This makes the sends idempotent across retries AND repeat sign-ins
(the claim is per member per sender, independent of `app_users.welcome_chat_sent`).

### A.4 Who, when, retroactivity
- **Cohort:** members whose `user_tenants.created_at >= WELCOME_ROLLOUT_AT` (plus VOA's
  "joined in last 30 days at rollout" if the partner wants parity). Older members are never
  in the cohort → requirement 1.7 (no retroactive sends) is satisfied by the cohort gate,
  not by scanning history.
- **Exclusion:** `fetchExcludedTestServiceAccountIdsStrict` (fail-closed) before every send
  — requirement 1.8.
- **Mariia (offset 0):** sent by the gateway tick on the first run after registration (not a
  DB trigger). "After registration is complete" = cohort member present with a coach/claim
  row and offset 0 elapsed.
- **Jovana (1d) / Alex (2d):** each eligible when `now_local >= created_at_local + staggerDays`.
  Delivered through `claim_onboarding_touch` so they count as that day's paced touch (one
  touch/local day) and never arrive together. Mariia's DM, like VOA's, is **not** a ledger
  touch (it has its own claim) so it can land on day 0 alongside the coach's day-0 step
  budget without consuming it.

### A.5 Sending & replies
- Insert a 1:1 `chat_messages` row: `sender_id = <sender userId>`, `receiver_id = newcomer`,
  `message_type='text'`, `metadata={ source:'welcome_team', sender_slug, automated:true }`,
  `sender_vitana_id`/`receiver_vitana_id` populated as the existing trigger does.
- Because the DM is authored by the real sender account, the newcomer's reply is an ordinary
  inbound DM in that account's existing inbox — requirement 1.9, no new routing. Alex's copy
  sets a help expectation without promising immediate response.

### A.6 Transport
Reuse `POST /api/v1/scheduled-notifications/...` behind `requireScheduledNotificationsAuth`
with the handler's own `X-Gateway-Internal` 401/503 check (VOA N1). Either extend the
onboarding-coach-tick or add a sibling `welcome-team-tick`; production gateway only
(staging refuses — shared DB). Partner to pick extend-vs-sibling (S2).

---

## Part B — "Say Hello 👋" on new-member cards

> **AMENDED 2026-10-15 by the coordinator after sparring (owner decision D2 = b).** The greeting is a private DM sent on the
> sender's explicit Send, not a comment: B.2 (backing post, `post_kind`), the comment-based B.4 greeted logic and the
> comment-notification B.5 below are **superseded**. Authoritative design: `plan-sparring.md` (plan block, Part B, S4). Where
> this section and the plan block differ, the plan block wins.

### B.1 Opt-in to being introduced (requirement 2.1)
New column (vitana-v1 migration) `profiles.community_intro_opt_in boolean` (or
`global_community_profiles` — partner picks the table the card reads, S3). Default per owner:
proposed **opt-in = true by default** at registration with an easy off switch (newcomers are
shy; VOA's whole premise). If the owner prefers explicit opt-in, flip the default — one line.
Card source query in `useAllNewsFeed.ts` adds `.eq('community_intro_opt_in', true)`.

### B.2 A real backing post to comment under
The new-member card is synthetic today (built from `global_community_profiles`, not a
`profile_posts` row), so there is no comment target. Create one **service-role** welcome
`profile_posts` row per opted-in newcomer, `post_kind='welcome'` (reusing VOA's planned
`post_kind` column; a trigger lets only service_role set it, and `trg_notify_community_post`
skips it so creating the card fires no tenant-wide push). The card renders this post's id;
"Send" posts a `profile_post_comments` row under it via the existing `useFeedPostInteractions
('post', welcomePostId).addComment()` — no new write path, RLS as today.

### B.3 Greeting suggestion endpoint (model-composed, Bedrock)
New gateway route `POST /api/v1/community/new-member/:userId/greeting-suggestion`
(authenticated member). Reuses the `composer.ts` pattern:
- intent (English): "Write ONE short, friendly greeting welcoming {firstName} to the MAXINA
  community. 1 short sentence. Vary wording and structure. Do not invent shared interests or
  familiarity. At most one emoji." + `avoid`: the suggestions already shown this session.
- `callViaRouter('operator', intent, { providerOverride:'bedrock', fallbackOverride:{bedrock},
  systemPrompt: buildLocalizedSystemPromptForLang(BASE, senderLocale) })`.
- `validateComposition` + a length cap (~120 chars), reject links/markdown; reject if it
  names an interest/topic (simple guard) — satisfies 2.6.
- Returns `{ suggestion, language }` so the UI shows "in {language}" (2.7). "Try another"
  re-calls with the running `avoid` list (2.5, anti-repeat within session).
Sender's language from `useLanguage().selectedLanguage`; this is the *suggestion* language
made clear to the sender (2.7, 3.1).

### B.4 UI (vitana-v1, `NewMemberCard.tsx` + new `NewMemberGreetingComposer.tsx`)
- "Say Hello 👋" button toggles an inline composer (Textarea prefilled with the suggestion +
  Send + "Try another"). Tailwind utilities + `@/components/ui/*` only — no inline JS/CSS, no
  CDN (CSP rules). Labels via `t()` from `@/lib/i18n-toast`.
- Send: disabled while in flight (2.8); on success collapse the composer and mark greeted.
- Never auto-send; nothing posts without Send (2.4, 2.10).
- Extend `fetchGreetedMemberIds` (`new-member-greeted.ts`) to also count a comment the
  viewer authored on that newcomer's welcome post, so a greeted card hides for that sender
  (today it counts DMs only).

### B.5 Grouped welcome notifications (requirement 2.9)
A dedicated comment-notification path for `post_kind='welcome'` comments: instead of one
`post_comment` push per greeter, group per-newcomer within a window (reuse the 24h dedup
precedent in `20261007100000_vtid_04916_...` / the cumulative-like grouping
`20260819120000_vtid_03684_...`). Design: the welcome-comment trigger upserts a single
grouped `user_notifications` row per newcomer per window ("{n} people said hello 👋"),
localized to the newcomer via `_notif_user_locale`. Partner to confirm window length (S4).

---

## Config summary (all configurable — requirement 3.3)
| Thing | Where |
|---|---|
| Three sender user_ids | gateway env `WELCOME_SENDER_*_ID` |
| Stagger offsets | gateway env `WELCOME_STAGGER_DAYS_*` |
| Rollout timestamp (cohort gate) | gateway env `WELCOME_ROLLOUT_AT` |
| Mode / send switch | `welcome-team/config.ts` (`COMPANION`-style) |
| Team-welcome content | `tt()` catalog keys (Option A) — one per sender per locale |
| Greeting-suggestion guidance | `BASE` prompt constant + length cap in the route module |
| Opt-in default | migration default + `VITE_` flag if a FE toggle is wanted |
| Grouping window | gateway env |

## Verification (rules 46–48)
- **CI simulation** (in-memory DB + fake clock), golden scenarios: Mariia at reg; Jovana/Alex
  staggered (never same day); each sender sent once across retries + re-sign-in; existing
  member gets nothing; excluded account gets nothing (and fail-closed on lookup error); reply
  lands as inbound DM; opt-out newcomer → no card/post; "Try another" varies and never repeats
  within a session; Send posts exactly one comment; double-submit prevented; N greetings → one
  grouped notification; suggestion/welcome languages correct.
- **Read-only staging specs:** `GET` status endpoint reports `disabled-on-staging`; the card
  does not render for the non-opted-in test account; endpoints return JSON not HTML.
- No test writes to staging/production. Live rollout = VOA closed pilot + two owner gates.

## Open questions for the sparring partner
- S1: team-welcome text — `tt()` catalog (recommended) vs model-composed.
- S2: extend onboarding-coach-tick vs a sibling welcome-team-tick.
- S3: which table carries `community_intro_opt_in`, and the default (opt-in vs opt-out).
- S4: grouped-notification window length and copy.
- S5: cohort = post-rollout only, or also "joined in last 30 days" (VOA parity).
- S6: Mariia account display_name is "maksinamariia", not "Mariia Maksina" — fix the account
  before go-live, or accept as-is (affects catalog "from" rendering).
