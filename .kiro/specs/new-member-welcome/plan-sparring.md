# new-member-welcome — Plan sparring record

- **Plan hash:** (filled after the last revision)
- **Change class:** standard · **Partner:** `plan-sparring-partner` (independent, read-only, Claude Opus 4.6 on Bedrock)
- **Coordinator session:** `session_01LKkSBuw1tGgnKzjhfcmAxj` (`_plan` claim `new-member-welcome/_plan`)
- **Author of the draft:** Kiro `kiro-202610150924-9ecd` (PR exafyltd/vitana-platform#4123)
- **VTIDs:** none yet — allocated only after the owner's Gate 1 "yes". On approval this file is copied to
  `docs/validation/<first VTID>/plan-sparring.md` in the first lane's PR.

# Plan — New-member welcome experience (three team DMs + "Say Hello 👋" card)

<!-- plan:begin -->
## Goal
Refine the approved VOA plan (`docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md` §4.5.5) into (A) three private welcome
DMs from Mariia, Jovana and Alex Blue, and (B) a "Say Hello 👋" greeting composer on the new-member feed card with
grouped notifications for the newcomer. Spec: `.kiro/specs/new-member-welcome/{requirements,design,tasks,content-welcome-seed}.md`.
Nothing existing is deleted; the VTID-03089 newcomer "Hello" DM fan-out stays.

## Change class and scope
Class: **standard** (migrations, a gateway route, a scheduled tick, a feed-card change, two repos).
Four lanes, one VTID each, executor Kiro:
- `team-welcome-backend` [platform] — `services/gateway/src/services/welcome-team/**` (new), a tick route in
  `services/gateway/src/routes/scheduled-notifications.ts`, one migration (`welcome_team_claims` + claim/finish RPCs),
  `catalog.ts` + `locales/*.json` (3 body keys × 11 locales), tests, `docs/validation/<VTID>/staging-tests.json`.
- `new-member-card-optin` [v1] — migration (`community_intro_opt_in`, `profile_posts.post_kind`, welcome-post backing),
  `src/hooks/useAllNewsFeed.ts`, `src/lib/new-member-greeted.ts`, tests.
- `say-hello-composer` [platform + v1] — gateway route `POST /api/v1/community/new-member/:userId/greeting-suggestion`,
  `src/components/home/NewMemberCard.tsx`, new `NewMemberGreetingComposer.tsx`, `src/i18n/{de,en,…}/**`, tests, screenshots.
  depends_on `new-member-card-optin`.
- `grouped-welcome-notifications` [v1] — one migration, tests. depends_on `new-member-card-optin`.

## Decisions on the six open questions (the planner's positions, to be attacked)
**S1 — team-welcome text: `tt()` catalog (Option A).** A written message from a named person falls under the catalog rule,
not rule 41 (which covers *spoken* lines; VOA §4.5.5 decided the same). Each sender approves their exact wording once; the
approval is recorded in the lane's VTID. Locale gate: the send is allowed only for locales whose three keys are `ready`;
for any other locale the member gets the `en` text (existing catalog fallback), never a half-translated one. `ar` may ship
later (falls back to `en`). Community-greeting *suggestions* (Part B) stay model-composed because a human edits them.

**S2 — sibling tick, not an extension of the coach tick.** `POST /api/v1/scheduled-notifications/welcome-team-tick`
(same `requireScheduledNotificationsAuth` + own `X-Gateway-Internal` 401/503 check, production gateway only, staging
refuses). The coach has no live mode yet (`onboarding-coach/config.ts`: slice 1 is `shadow`), so extending it would tie the
welcome rollout to the VOA coach rollout. **The three welcomes do NOT use `claim_onboarding_touch`:** they are not a
paced coaching touch; each has its own claim row (`welcome_team_claims`, PK `(user_id, sender_slug)`) plus a `due_at`
computed from `user_tenants.created_at + staggerDays`. "Never the same day" is guaranteed by stagger offsets 0/1/2 days and
tested; the ledger's one-touch-per-day budget stays untouched by welcomes.

**S3 — opt-in column on the profile table the card reads; default `true` for members who register after rollout, `false`
for everyone else; visible off-switch in Settings and in the registration wizard.** The card source today is
`global_community_profiles` (last 7 days); the migration adds `community_intro_opt_in` to the underlying table and exposes
it through that view. Requirement 2.1 says "explicit choice" — default-on is the one place the plan departs from a strict
reading, so it is flagged as **owner decision D1** with the strict alternative (default `false` + explicit toggle shown in
the wizard) priced: the card shows far fewer newcomers.

**S4 — grouping window: 24 h per newcomer** (the VTID-04916 precedent). The first greeting notifies immediately
("{n} people said hello 👋" starts at n=1); further greetings in the window update the same `user_notifications` row's
count and do NOT push again; a new window starts after 24 h. Localised through `_notif_user_locale`.

**S5 — cohort: members whose `user_tenants.created_at >= WELCOME_ROLLOUT_AT` only.** No "last 30 days" back-fill: it would
DM people who joined weeks ago and is not needed for requirement 1.7. The cohort gate is the only retro-protection.

**S6 — account data is a go-live pre-flight, not code.** Mariia's account shows `display_name = "maksinamariia"` and
`vitana_id = mariia11` while her handle is `@mariia04`; Alex Blue's account shows `display_name = "Dragan Alexander"` while the
message says "I'm Alex". The DM renders the real sender profile, so the newcomer would see those names. Pre-flight (a gate in
the rollout checklist, read-only check by the tick's status endpoint): the three senders' display names are the names the
senders want newcomers to see — fixed by the account owners, not by migration. The tick refuses to go `live` while
`WELCOME_SENDER_NAMES_CONFIRMED` is unset.

## Part A — design summary (lane `team-welcome-backend`)
- Config module `welcome-team/config.ts`: `mode` (`disabled-on-staging | off | shadow | live`), explicit send switch,
  senders `{slug, userIdEnv, staggerDays}`, rollout timestamp, pilot allowlist (same closed-pilot discipline as VOA).
  IDs: Mariia `67c971fc-48f3-49ce-aaa8-cddb6fa9e63a` (0 d), Jovana `c7d3260d-8311-4a0b-ab1c-53928a37caec` (1 d),
  Alex Blue `0adc6ff6-acb0-4dca-99d0-295211a40e3e` (2 d; **real human**: no AI-identity line, no immediate-reply promise).
- Migration `welcome_team_claims(user_id, sender_slug, status pending|sent|failed, attempts 1..2, …)`, RLS on with zero
  policies; `claim_welcome_message` / `finish_welcome_message` SECURITY DEFINER, service_role only. Send-once per member per
  sender across retries and repeat sign-ins; `failed` is retried once.
- Tick: cohort gate → strict fail-closed exclusion (`service_bot_accounts` ∪ `notification_test_actors`, error ⇒ skip) →
  never message a sender to themselves → claim → resolve recipient locale (`getUserLocale`) → `tt()` body with `{name}`
  (no-name variant when unknown) → insert the 1:1 `chat_messages` row authored by the sender account
  (`metadata.source='welcome_team'`, `sender_slug`, `done_by_vitana=false` for the human accounts, `automated=true`) →
  `finish_welcome_message`. Replies are ordinary inbound DMs to the sender's own inbox (no new routing).
- Writes happen only in the production gateway, only in `live` mode, only for allowlisted pilot members until the owner
  widens it. Staging and CI never write to a live system.

## Part B — design summary (lanes B/C/D)
- Backing post: one service-role `profile_posts` row with `post_kind='welcome'` per opted-in newcomer so the synthetic card
  has a comment target. `post_kind` is added by this plan (it does not exist in `supabase/migrations` today — VOA slice 5 owns
  `'inspiration'`; the migration defines the column once with a check list incl. both kinds). A trigger lets only
  service_role set it; `trg_notify_community_post` skips `'welcome'` so creating the card fires no tenant-wide push.
- Card: `useAllNewsFeed.ts` sources newcomers only where `community_intro_opt_in`; maps the card to the backing post id.
- Composer: inline editable greeting (`NewMemberGreetingComposer.tsx`), "Try another", "in {language}" affordance, Send posts
  exactly one comment through the existing `useFeedPostInteractions('post', welcomePostId).addComment`; never auto-sends;
  disabled while in flight.
- Suggestion route: Bedrock-only via the `composer.ts` pattern (English intent, sender-locale system prompt, `avoid` list,
  validation, ~120-char cap, no links/markdown, no invented interests). Authenticated member only; per-viewer rate limit.
- `fetchGreetedMemberIds` also counts a comment the viewer wrote under the newcomer's welcome post.
- Grouped notification: a trigger on `profile_post_comments` for `post_kind='welcome'` posts upserts one grouped
  `user_notifications` row per newcomer per 24 h window.

## Test plan (no test writes to staging or production — CLAUDE.md rules 31–32, 46–48)
- CI simulation, in-memory DB + fake clock (golden scenarios): Mariia at day 0; Jovana day 1; Alex day 2, never the same
  day; each sender sent once across retries and re-sign-in; `failed` retried once then stays failed; pre-rollout member gets
  nothing; excluded account gets nothing and a lookup error ⇒ skip; sender never messages themselves; locale not `ready` ⇒ `en`;
  reply lands as an inbound DM; staging mode refuses to send.
- Part B: opted-out newcomer ⇒ no card/post; opted-in ⇒ card mapped to post; greeted card hides; Try-another varies and never
  repeats in a session; Send posts exactly one comment; double-submit blocked; N greetings in 24 h ⇒ one grouped row, one push,
  right language; backing-post creation fires no tenant push.
- Read-only staging specs: status GET reports `disabled-on-staging`; card absent for the non-opted-in test account; routes
  return JSON not HTML. Screenshots desktop 1400×900 + mobile 390×844, LTR and `ar` RTL for the composer.
- Live rollout: closed pilot (allowlist) then widening, each a separate owner-visible step; Gate 2 from STAGING-VERIFY evidence.

## Out of scope
VTNA reward rules; VOA slices 3, 5, 6; email; changing the VTID-03089 newcomer fan-out DM.
<!-- plan:end -->

## Round 1
(pending)
