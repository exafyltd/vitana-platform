# new-member-welcome — Plan sparring record

- **Plan hash (sha256 of the text between the plan markers, first 16 hex):** `f7cdefc3043249c5`
- **Verdict:** CONVERGED (round 4 closing pass after the owner's D2 = b scope change: F10–F12 closed; F13 minor accepted)
- **Owner approval (Gate 1):** 2026-10-15, owner "yes" in the Claude Code session `session_01LKkSBuw1tGgnKzjhfcmAxj` (plan hash `f7cdefc3043249c5`; D1 = default ON, no sender approval)
- **Change class:** standard · **Rounds:** 4 (R1 findings, R2 close, R3 scope change, R4 close) · **Partner:** `plan-sparring-partner` (independent, read-only, Claude Opus 4.6 on Bedrock)
- **Coordinator session:** `session_01LKkSBuw1tGgnKzjhfcmAxj` (`_plan` claim `new-member-welcome/_plan`)
- **Author of the draft:** Kiro `kiro-202610150924-9ecd` (PR exafyltd/vitana-platform#4123)
- **VTIDs (allocated 2026-10-15 after Gate 1, log-mode gate):** VTID-05205 `team-welcome-backend`, VTID-05206 `new-member-card-optin`,
  VTID-05207 `say-hello-composer`, VTID-05208 `grouped-welcome-notifications`. Each lane PR copies this record to
  `docs/validation/<its VTID>/plan-sparring.md`.

# Plan — New-member welcome experience (three team DMs + "Say Hello 👋" card)

<!-- plan:begin -->
## Goal
Refine the approved VOA plan (`docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md` §4.5.5) into (A) three private welcome
DMs from Mariia, Jovana and Alex Blue, and (B) a "Say Hello 👋" greeting composer on the new-member feed card that, on the
member's explicit Send, delivers a private DM to the newcomer, with grouped notifications for the newcomer.
**Owner decision 2026-10-15 (D2 = option b): the greeting is a DM from the member who pressed Send, not a public comment;
nothing is sent until that member presses Send (requirements 2.4/2.10 stay).** Spec: `.kiro/specs/new-member-welcome/{requirements,design,tasks,content-welcome-seed}.md`.
Nothing existing is deleted; the VTID-03089 newcomer "Hello" DM fan-out stays.

## Change class and scope
Class: **standard** (migrations, a gateway route, a scheduled tick, a feed-card change, two repos).
Four lanes, one VTID each, executor Kiro:
- `team-welcome-backend` [platform] — `services/gateway/src/services/welcome-team/**` (new), a tick route in
  `services/gateway/src/routes/scheduled-notifications.ts`, one migration (`welcome_team_claims` + claim/finish RPCs),
  `catalog.ts` + `locales/*.json` (3 body keys × 11 locales), tests, `docs/validation/<VTID>/staging-tests.json`.
- `new-member-card-optin` [v1] — migration (`community_intro_opt_in` on `global_community_profiles`),
  `src/hooks/useAllNewsFeed.ts` (source cards only for opted-in newcomers), Settings/wizard off-switch, tests.
- `say-hello-composer` [platform + v1] — gateway route `POST /api/v1/community/new-member/:userId/greeting-suggestion`,
  `src/components/home/NewMemberCard.tsx`, new `NewMemberGreetingComposer.tsx`, `src/i18n/{de,en,…}/**`, tests, screenshots.
  depends_on `new-member-card-optin` (the server guard reads the opt-in) and `grouped-welcome-notifications` (so no
  greeting DM can reach a newcomer before the push grouping exists).
- `grouped-welcome-notifications` [platform] — coalesce greeting-DM pushes per recipient (see S4), tests. No dependencies.
  Merge order: opt-in and grouping first (parallel), then the composer; the card button keeps navigating to the DM thread
  until the composer lane lands, so there is no window with greetings but no grouping or no opt-out.

## Decisions on the six open questions (the planner's positions, to be attacked)
**S1 — team-welcome text: `tt()` catalog (Option A).** Launch locales: `de` and `en` are `ready` for the closed pilot; every
other locale falls back along the existing chain (locale → `en` → `de`, `catalog.ts`). Widening beyond the pilot allowlist
requires all of `es sr fr pt ru pl zh tr` `ready` (a rollout-checklist gate; `ar` may follow). Fallback-to-`en` for pilot
members is recorded under "Decisions taken" at Gate 2. A written message from a named person falls under the catalog rule,
not rule 41 (which covers *spoken* lines; VOA §4.5.5 decided the same). **Owner decision 2026-10-15: the welcomes go out
automatically, without a per-sender approval step** (this reverses the VOA §4.5.5 sender-approval precedent for these three
senders; the wording is the seed text in `content-welcome-seed.md`, reviewed through the normal locale review only). Locale gate: the send is allowed only for locales whose three keys are `ready`;
for any other locale the member gets the `en` text (existing catalog fallback), never a half-translated one. `ar` may ship
later (falls back to `en`). Community-greeting *suggestions* (Part B) stay model-composed because a human edits them.

**S2 — sibling tick, not an extension of the coach tick.** `POST /api/v1/scheduled-notifications/welcome-team-tick`
(same `requireScheduledNotificationsAuth` + own `X-Gateway-Internal` 401/503 check, production gateway only, staging
refuses). The coach has no live mode yet (`onboarding-coach/config.ts`: slice 1 is `shadow`), so extending it would tie the
welcome rollout to the VOA coach rollout. **The three welcomes do NOT use `claim_onboarding_touch`:** they are not a
paced coaching touch; each has its own claim row (`welcome_team_claims`, PK `(user_id, sender_slug)`) plus a `due_at`
computed from `user_tenants.created_at + staggerDays`. "Never the same day" is guaranteed by stagger offsets 0/1/2 days and
tested; the ledger's one-touch-per-day budget stays untouched by welcomes.

**S3 — opt-in column on `global_community_profiles` (a plain table, verified); default `true` for members who register after
rollout, `false` for everyone else; visible off-switch in Settings and in the registration wizard.** The card source today is
that table (last 7 days, `useAllNewsFeed.ts:199-204`); the migration adds `community_intro_opt_in` to it directly and
checks that existing RLS policies and the `REPLICA IDENTITY FULL` realtime publication are unaffected. Requirement 2.1 says "explicit choice" — default-on is the one place the plan departs from a strict
reading, so it is **owner decision D1, answered 2026-10-15: default ON** — new members are included automatically, with the off-switch. The
strict alternative (default `false` + explicit toggle) is not taken.

**S4 — grouping window: 24 h per newcomer, applied to greeting DMs.** Greeting DMs carry `metadata.source='new_member_greeting'`.
Today `chat-push-coalescer.ts` (VTID-05137) allows one push per conversation per 5 min, i.e. per SENDER, so 200 different
greeters would still mean 200 pushes. The lane adds a second rule in the gateway's chat-notification path for tagged DMs: the
first greeting DM in a 24 h window pushes normally; later tagged DMs in the window write their in-app `user_notifications` row
(the bell stays complete) but do not push, and the pushed/in-app summary reads "{n} people said hello 👋" localised via
`_notif_user_locale`. Off switch env var, fails open like the existing coalescer. Premise to verify in round 3: tagged DMs
reach that notification path via `POST /api/v1/chat/send` (`routes/chat.ts:58`) and `metadata` survives it.

**S5 — cohort: members whose `user_tenants.created_at >= WELCOME_ROLLOUT_AT` only.** No "last 30 days" back-fill: it would
DM people who joined weeks ago and is not needed for requirement 1.7. The cohort gate is the only retro-protection.

**S6 — account data is a go-live pre-flight, not code.** Mariia's account shows `display_name = "maksinamariia"` and
`vitana_id = mariia11` while her handle is `@mariia04`; Alex Blue's account shows `display_name = "Dragan Alexander"` while the
message says "I'm Alex". The DM renders the real sender profile, so the newcomer would see those names. Pre-flight (a gate in
the rollout checklist, read-only check by the tick's status endpoint): the three senders' display names are the names the
senders want newcomers to see — fixed by the account owners, not by migration. The tick refuses to go `live` while
`WELCOME_SENDER_NAMES_CONFIRMED` is unset. **No backlog on go-live:** `WELCOME_ROLLOUT_AT` is set to the moment the mode is
flipped to `live`, so nobody who registered during the confirmation delay is in the cohort, and the tick caps sends at N
claims per invocation.

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
- "Production gateway only" reuses the staging predicate of `onboarding-coach/config.ts` (the one that yields
  `disabled-on-staging`); a golden scenario asserts the tick sends nothing when that predicate is true.
- Writes happen only in the production gateway, only in `live` mode, only for allowlisted pilot members until the owner
  widens it. Staging and CI never write to a live system.

## Part B — design summary (lanes `new-member-card-optin`, `say-hello-composer`, `grouped-welcome-notifications`)
- **No backing post, no `post_kind`, no trigger replacement, no comment path** (all dropped by the owner's D2 = b; the round-1
  findings F2, F6, F8, F9 about that path no longer apply).
- Card: `useAllNewsFeed.ts` sources newcomers only where `community_intro_opt_in` (column on `global_community_profiles`, see S3).
- Composer: "Say Hello 👋" opens an inline editable greeting (`NewMemberGreetingComposer.tsx`), prefilled with a suggestion,
  "Try another", an "in {language}" affordance. **Send** delivers ONE DM to the newcomer from the member who pressed it, through
  the same gateway endpoint the inbox uses (`POST /api/v1/chat/send`, `routes/chat.ts:58`) with
  `metadata.source='new_member_greeting'`; disabled while in flight (no double submit); on success the composer collapses and the
  card hides for that member. Never auto-sends — pressing "Say Hello" alone sends nothing.
- Suggestion route: Bedrock-only via the `composer.ts` pattern (English intent, sender-locale system prompt, `avoid` list,
  validation, ~120-char cap, no links/markdown, no invented interests). Authenticated member only; per-viewer rate limit.
- **Deliberate behaviour change:** today "Say hello" navigates to the DM thread (`NewMemberCard.tsx:104`); it becomes the inline
  composer whose Send creates that DM. The thread stays reachable from the avatar/profile.
  `fetchGreetedMemberIds` (`new-member-greeted.ts`) is unchanged: it already counts viewer-sent DMs, which is exactly what Send
  creates, so the card hides after Send and for members who already greeted by DM.
- **Server-side greeting guard (new, from round-3 finding F10).** `POST /api/v1/chat/send` enforces no block, mute or rate
  limit for plain text DMs today (`routes/chat.ts:58-125`; the VTID-05104 `checkInviteSend` guard covers only calendar invites),
  and that stays as is: it is a pre-existing gap for ordinary DMs, outside this plan, reported to the owner as a follow-up
  note. For DMs carrying `metadata.source='new_member_greeting'` the route adds a guard modelled on `checkInviteSend`
  (`services/calendar-invite-guard.ts`), fail-closed, answering one generic refusal status: (a) the receiver has not blocked or
  muted the sender (`user_blocked_authors` / `user_muted_authors`, the tables `useAllNewsFeed.ts` already honours); (b) the
  receiver has `community_intro_opt_in` true and joined within the card's 7-day window; (c) neither party is in
  `service_bot_accounts` ∪ `notification_test_actors`; (d) no earlier greeting DM from this sender to this receiver exists
  (SELECT bounded by `sender_id` + `receiver_id` + the 7-day card window first, then the tag, so it stays within index range), so "one greeting per pair" is enforced by the server, not only by the card hiding; (e) a per-sender cap
  of greetings per hour. Omitting the tag only makes it an ordinary DM — exactly what any member can send today — so the tag
  adds restrictions and cannot be used to bypass them. The newcomer set is cross-tenant (`global_community_profiles`);
  tenant behaviour of `/send` is unchanged from the current "Say hello" button, which also lands in the same inbox.

## Test plan (no test writes to staging or production — CLAUDE.md rules 31–32, 46–48)
- CI simulation, in-memory DB + fake clock (golden scenarios): Mariia at day 0; Jovana day 1; Alex day 2, never the same
  day; each sender sent once across retries and re-sign-in; `failed` retried once then stays failed; pre-rollout member gets
  nothing; excluded account gets nothing and a lookup error ⇒ skip; sender never messages themselves; locale not `ready` ⇒ `en`;
  reply lands as an inbound DM; staging mode refuses to send.
- Greeting guard (golden scenarios, in-memory DB): blocked/muted sender ⇒ refused; non-opted-in or older-than-7-days
  receiver ⇒ refused; excluded account ⇒ refused; second greeting from the same sender to the same receiver ⇒ refused;
  hourly cap ⇒ refused; guard lookup error ⇒ refused; untagged ordinary DM ⇒ behaves exactly as today.
- Part B: opted-out newcomer ⇒ no card; opted-in ⇒ card; pressing Say Hello alone sends nothing; Try-another varies and never
  repeats in a session; Send creates exactly one DM with `metadata.source='new_member_greeting'`, from the pressing member to the
  newcomer; double-submit blocked; greeted card hides; N greeting DMs in 24 h ⇒ N in-app rows, one push, summary in the
  newcomer's language, and the existing per-conversation coalescing is unchanged for ordinary DMs.
- Read-only staging specs: status GET reports `disabled-on-staging`; card absent for the non-opted-in test account; routes
  return JSON not HTML. Screenshots desktop 1400×900 + mobile 390×844, LTR and `ar` RTL for the composer.
- Live rollout: closed pilot (allowlist) then widening, each a separate owner-visible step; Gate 2 from STAGING-VERIFY evidence.

## Out of scope
VTNA reward rules; VOA slices 3, 5, 6; email; changing the VTID-03089 newcomer fan-out DM.
<!-- plan:end -->


## Round 1 — partner findings (verbatim summary) and planner responses
Partner verified: `post_kind` absent (TRUE); card source `global_community_profiles` last 7 days, `useAllNewsFeed.ts:199-204`
(TRUE); coach `shadow` only, `config.ts:46` (TRUE); `global_community_profiles` is a TABLE, not a view (the plan said view →
FALSE); `requireScheduledNotificationsAuth` used (TRUE). Planner re-verified F1–F3 independently in the code before answering.

- **F1 [major] — plan called `global_community_profiles` a view.** ACCEPTED. Verified: `CREATE TABLE`
  (`20250917153624_…sql:5`). Plan text corrected; migration adds the column directly and checks RLS and realtime.
- **F2 [major] — `trg_notify_community_post` fires on a `is_public=true` backing post.** ACCEPTED. Verified: AFTER INSERT trigger;
  function last replaced in VTID-05126. Plan now names the approach (replace the function from its latest body with an early
  return for `'welcome'`; keep `is_public=true`) and adds a CI test over all migrations asserting zero notifications.
- **F3 [major] — "Say hello" changes from private DM to public comment, undocumented.** ACCEPTED. Verified:
  `NewMemberCard.tsx:104`. Plan now states it is deliberate, the DM remains reachable from the profile, and greeted-detection is
  the union of DMs and comments. Raised to the owner as D2.
- **F4 [minor] — how the tick knows it is on staging.** ACCEPTED. Reuses the coach staging predicate; golden scenario added.
- **F5 [minor] — backlog burst when the names flag flips.** ACCEPTED. `WELCOME_ROLLOUT_AT` = flip time (no backlog by
  construction) plus a per-invocation cap.
- **F6 [minor] — `post_kind` CHECK pre-empts VOA slice 5.** ACCEPTED. CHECK allows only `NULL`/`'welcome'`; slice 5 ALTERs.
- **F7 [minor] — which locales are `ready` at launch.** ACCEPTED. `de`, `en` for the pilot; fallback chain for the rest; full set
  required before widening; recorded under "Decisions taken".

## Round 2 — partner response
F1–F7: all **closed**. Partner verified (a) VTID-05126 (`20261012120000_…:124`) is the latest of six definitions of
`notify_community_on_public_post()`; the only later migration (`20261013160000_vtid_05133_ai_discoverable.sql`) does not touch
it; (b) the `welcome` early return belongs right after the test-actor guard (`:131`), before the tenant lookup.
New findings, both minor:
- **F8** — `trg_notify_post_mention_insert` fires on every `profile_posts` insert. ACCEPTED: backing post sets `mentions` NULL;
  the zero-notification CI test covers it.
- **F9** — `trg_profile_posts_guard` (suspension, 20/hour) has no service-role bypass. ACCEPTED: behaviour is correct (no welcome
  post for a suspended newcomer); stated in the plan and covered by a test.
**Verdict: CONVERGED.** F8/F9 were added to the plan after the partner's last pass (documentation only; hash above covers them).

## Round 3 — scope change after round 2 (owner decision, 2026-10-15)
Between rounds the owner answered D2: the greeting is a **private DM from the pressing member** (option b: composer → explicit
Send → DM), not a public comment under a welcome post. The plan block above was rewritten accordingly; Part B no longer has a
backing post, `post_kind`, the notify-trigger replacement or a comment path, so round-1 findings F2, F3 (comment direction), F6,
F8 and F9 are **superseded** (kept above as the record). New surface for the partner to attack: the DM send path
(`POST /api/v1/chat/send`), the `metadata.source='new_member_greeting'` tag, the greeting-DM push grouping (S4) built next to
`chat-push-coalescer.ts`, and the abuse/flood bound. Planner responses to round-3 findings follow below.

### Round 3 — planner responses
Partner verified: `POST /send` is the right path (`chat.ts:58`); `metadata` is stored verbatim (`chat.ts:84,126-135`,
`chat-repository.ts:20-21`) and is in scope at the notification dispatch (`chat.ts:249-257`), where `coalesceChatPushes` is keyed
`dm:<senderId>`; `fetchGreetedMemberIds` needs no change. Superseded F2, F3, F6, F8, F9 → closed-by-scope-change (no contest).
- **F10 [major] — plan claimed normal DM block/rate-limit rules that do not exist.** ACCEPTED, and verified independently:
  `chat.ts:89` is the calendar-invite branch only. The false claim is removed. Plain DMs stay as they are (pre-existing gap,
  noted for the owner, not built here); tagged greeting DMs get the server-side guard (a)–(e) listed in Part B, including a
  server-enforced one-greeting-per-pair, so the abuse bound no longer rests on the UI.
- **F11 [minor] — grouping lane independent ⇒ a window with ungrouped pushes.** ACCEPTED. `say-hello-composer` now depends_on
  `grouped-welcome-notifications`; until it lands the card button still opens the DM thread as today.
- **F12 [minor] — composer before opt-in ⇒ no opt-out control.** ACCEPTED. `say-hello-composer` now depends_on
  `new-member-card-optin`; the guard also checks the opt-in server-side.
- Q1: not a new gap, a pre-existing one; the plan no longer implies otherwise. Q2: the pilot allowlist limits Part A recipients
  only, not who may greet — which is why the grouping lane gates the composer instead of relying on the pilot.

### Round 4 — partner closing pass (after the scope change)
F10, F11, F12 **closed**; F2, F3, F6, F8, F9 closed-by-scope-change. Partner verified `calendar-invite-guard.ts` is a workable model
(fail-closed, single generic refusal, `fetchExcludedTestServiceAccountIdsStrict` reusable, pure quota split) and that
`user_blocked_authors` / `user_muted_authors` / `global_community_profiles` are already read by gateway services with the service
client. New finding, minor: **F13** — the one-per-pair and hourly-cap queries filter `chat_messages` on `metadata->>'source'`
(no index). ACCEPTED: the plan now bounds the lookup by `sender_id` + `receiver_id` + the 7-day window before the tag test.
**Verdict: CONVERGED.** F13's wording change is in the plan (hash above covers it). The round-3 scope change used the one extra
round the skill allows; the record shows 4 rounds because of it.

### Owner decisions after round 4 (2026-10-15) — implementation of owner decisions, not re-argued with the partner
- **D1 = default ON.** New members after rollout are included automatically, with the off-switch (the plan's S3 default; the
  strict default-off alternative is not taken).
- **No sender approval.** Mariia, Jovana and Alex Blue do not approve their wording or the automation; the three welcomes go
  out automatically. This removes the VOA §4.5.5 sender-approval step for these senders (S1 sentence and the seed file amended).
  Consequences recorded: messages are sent from three real members' accounts without them being asked, and replies land in
  those members' inboxes. The S6 display-name check (`WELCOME_SENDER_NAMES_CONFIRMED`) stays: it is about what newcomers see,
  not sender consent.
- Plan hash changed to `f7cdefc3043249c5` because the S1 and S3 sentences changed; the partner's CONVERGED verdict covers the design, and
  these two sentences are owner decisions applied verbatim.
