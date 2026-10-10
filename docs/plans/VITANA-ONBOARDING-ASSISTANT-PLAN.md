# Vitana Onboarding Assistant (VOA) — Plan v3

Status: v3 FINAL — sparred (3 rounds, CONVERGED) · awaiting owner approval · 2026-10-05 · plan document VTID-04744 (each build slice gets its own VTID after owner approval, Plan Sparring Gate)
Repos: `vitana-platform` (coach engine, ORB, notifications, coach tables) + `vitana-v1` (Home card, permission priming, i18n, `profile_posts` migration)

## 0. What changed since v1 (2026-10-01 → 2026-10-05)

- **Audiobook is merged** (VTID-04760…04763: app `b230482` #1192, platform `b1116c0b` #3836). VOA now builds on it, not around a pending branch (§9.1).
- **VTNA reward rules are live** (VTID-04864/04878): one rule table `services/gateway/src/services/rewards/vtna-reward-rules.ts`; done-by-Vitana never earns VTNA (`VTNA_NEVER_EARNS`); invite reward 1,000 VTNA per friend (cap 10 / 30 days) plus a one-time 10,000 at 10 friends; `onboarding_complete` pays **at signup** (owner decision, VTID-04878). Former R-1 is decided.
- **Milestones already exist**: `milestone-service.ts` (VTID-01250) detects profile_complete, first_diary, first_group, first_event_rsvp, first_connection, first_referral and more, emits `user.milestone.reached` and is the VTNA payer. VOA extends it instead of building its own (§4.3).
- Founding 1000 (VTID-04859) seats new members with a celebration modal at signup — VOA's day-0 must not collide with it (§4.4).
- Scheduled-notification routes require the internal token (VTID-04677, `requireScheduledNotificationsAuth`).
- What's New has entries (`src/whats-new/entries/`, 5 today); VOA adds its own when a member-visible slice ships.

## 1. Problem

A member who registered yesterday gets the same product as one who registered 8 months ago. The system is big
(551+ screens, Autopilot, Journey, Index, community), new members are shy, don't ask, don't test — and disappear.
The one social mechanism we have (automatic "Hello" DM from the new member to everyone) gets almost no replies:
strangers get a message from someone they know nothing about.

Goal: for the first 90 days, a proactive, tenure-aware assistant that (a) teaches by doing, (b) makes the member
talk to Vitana within day 0–1, (c) does the socially scary steps *for* the member, with consent, and (d) never
nags. Established members are untouched.

## 2. What already exists (verified against main 2026-10-05)

Most parts are built. What's missing is an **owner that decides "what's the next best step for this member today"**
and drives every channel from that one decision.

| Building block | Where | State |
|---|---|---|
| Tenure model day0…day180plus, `active_usage_days` | `services/guide/journey-experience.ts`, `types.ts` | live, unused for onboarding |
| First-time-welcome ORB rung (prio 95, fires once) | `assistant-continuation/providers/first-time-welcome/` (now points at Audiobook Episode 1) | live; depends on lazily-created `user_journey` row (`ensureUserJourneyRow` only from the live session) |
| Greeting decision | `services/conversation/compute-greeting-decision.ts` (+ references in `orb-live.ts`) | live; covered by `test:roles` (rule 42h) |
| Audiobook (Season 0 T255–T260, 1 episode/day, opt-in daily reminder via `reminder_due`, `/analytics/audiobook`) | merged VTID-04760…04763 | live |
| Milestones + `user.milestone.reached` + VTNA payout | `services/milestone-service.ts`, `rewards/vtna-reward-rules.ts` | live — VOA extends these |
| Guided vs Full mode, `onboarding_status` | `user_guided_journey_state`, `routes/guided-journey.ts` | live |
| Journey Foundation steps | `services/journey-foundation/`, `user_journey_foundation` | live |
| 8-row `onboarding_*` Autopilot seed on signup | trigger `seed_onboarding_autopilot_on_primary_membership` | live; old rows carry "Maxina" copy |
| Welcome-chat DM fan-out (DB trigger) | `fire_welcome_chat_on_membership()` | live, **regressed** (§3.1) |
| Presence pacer (cap by `proactive_presence_level`: quiet 1 / balanced 2 / engaged 3; one touch per surface per day) | `services/guide/presence-pacer.ts` | live — the mandatory gate; no onboarding surface yet |
| Notifications: push (FCM+Appilix), in-app, prefs, quiet hours, catalog `unverified→ready` | `notification-service.ts`, `notification-controls/notification-catalog.ts` | live |
| Test/service-account exclusion | `lib/excluded-test-service-accounts.ts` (`…Strict` variant fails closed) | live |
| Connection proposals (`proposeToMember`), chat-on-behalf with read-back | `community-autopilot/automation-proposals.ts`, `orb-tools-shared.ts` | live (queue 93% rejected/expired — storage only for VOA, §4.5) |
| New-member card (hides after messaging, PR #1170), `NewsFeedItemCard`, `Inspiration.tsx` | vitana-v1 | live |
| Home feed with `cardSlots` (slot *n* renders after feed item *n*) | `src/pages/Home.tsx` | live |
| `profile_posts` (`is_public`), `trg_notify_community_post` (fires on INSERT when `is_public`, tenant-wide) | **vitana-v1** `supabase/migrations` | live; no `post_kind` column |
| Scheduled ticks via EventBridge + internal token | `scripts/aws/setup-eventbridge-daily-feature-tip.sh`, `requireScheduledNotificationsAuth` | live |
| Feature flags `off | staging-only | staging+prod` | `services/feature-flags.ts` (`isFeatureLive`) | live |

Dead / disconnected (do not build on): `/auth/login` hooks; AP-1301…1307 onboarding automations (AP engine dark);
`user_journey.onboarding_stage`, `welcome_to_vitana` notification. Welcome reply rate: **not measured anywhere.**

## 3. Fix-first list (small, independent PRs, before VOA)

1. **Welcome trigger regression.** `20260917084341_vtid_03990` re-created `fire_welcome_chat_on_membership()` from the old body:
   "Alle Beisammen" enrollment sits after the `>1000` early return and under a hard `<100` cap, so it stops at 100. New migration
   merges both (service-bot guard + enrollment first, uncapped for that group). Read the live definition first.
2. **Guarantee `user_journey` row at signup** (in the existing seed trigger) so `is_first_session` and tenure are reliable.
3. **Coach-only `onboarding_completed_at`** server-side marker for the coach. It does **not** change the `onboarding_complete`
   VTNA trigger, which pays at signup (VTID-04878).
4. **Measure the baseline** (read-only SQL): welcome-DM reply rate, D1/D7 return, time-to-first-ORB-conversation for the last 60 days of signups.

**Status (2026-10-10, sparred + owner approved):**
- Item 1 is done in VTID-05038: the trigger is restored and the 12 members who had been skipped were backfilled.
- Item 2 needs no work. `on_user_journey_created` on `auth.users` already inserts the row, and 0 of 237 primary members lack one. The coach takes tenure from `user_tenants.created_at`.
- Item 3 is superseded by `onboarding_coach_state.stage` (`done` at 90 days), which slice 1 shipped.
- Item 4 is done in VTID-05039: see `docs/validation/VTID-05039/baseline.md`.

## 4. Design

### 4.1 Principle
One brain, many mouths. A new **Onboarding Coach service** computes per-member state and the *single next best
action*; existing channels (ORB, Home card, push, in-app, Vitana DM, feed post) only render it. Every outbound touch
goes through the presence pacer and the touch ledger (§4.7). Nothing existing is deleted; the hello DM stays.

### 4.2 Cohort, pilot and gating
- Cohort (owner decision): registrations after `VOA_ROLLOUT_DATE` **plus members who joined in the last 30 days at rollout** (enter at their real tenure stage). Tenure < 90 days. Everyone else never sees VOA.
- **Pilot is closed on both sides.** During the pilot the coach acts only for `VOA_PILOT_USER_IDS` (Mariia Maksina, Jovana, Alex Red, Alex Blue) **and every counterparty must also be in that list**: intro candidates, DM recipients, group-post audience, feed cards and the new-member card. Concretely in pilot mode: intros only between pilot accounts; the Alle Beisammen "new faces" thread and the new-member-card enrichment are **off**; inspiration posts are author-only (owner decision). Lifting the pilot is a separate owner step.
- Pilot accounts are existing members, so they enter the ladder through a `pilot_stage_override` on their coach row (e.g. `d0`), removed when the pilot ends.
- Flag `FEATURE_ONBOARDING_ASSISTANT_ENV` via `isFeatureLive`, plus mode `shadow | live`. **The coach runs only on the production gateway**: staging and production share the production Supabase, so the staging gateway refuses the tick entirely (no shadow, no live — it would write coach rows into the production database) and the EventBridge schedule targets production only.
- **The tick enforces its own token.** The global `SCHEDULED_NOTIFICATIONS_AUTH_MODE` is `log` in both environments today (it lets untokened calls through), so the coach-tick handler checks `X-Gateway-Internal` itself regardless of that mode: 401 without a valid token, 503 if `GATEWAY_INTERNAL_TOKEN` is unset. Proven in Jest.
- Exclusion uses `fetchExcludedTestServiceAccountIdsStrict`; if it (or the pilot allowlist lookup) fails, the whole tick is skipped — "could not tell" never means "not excluded" (rules 43–45).
- Off-ramps: member says "stop" (existing `dismissal-tool`), completes the ladder, or day 90.
- Surfaces: the coach runs only on the community Assistant Profile (rule 42g) — never on work surfaces.

### 4.3 State and milestones
`onboarding_coach_state` (platform migration, gateway service-role only, RLS on, member can read own row):
`user_id, tenant_id, stage (d0,d1,d2_3,d4_7,d8_30,d31_60,d61_90,done), pilot_stage_override, last_touch_at, next_action_key,
snoozed_until, ignored_streak, opted_out_at`. (The Mariia welcome's state lives only in its own claim row, §4.5.5.)

**Milestones come from `milestone-service.ts`**, not a second detector. VOA adds the missing ones there — first ORB conversation,
push permission granted, Audiobook topics heard (by topic id: T255–T260, T251–T254), first DM *reply received* — with reward
amount 0 unless the owner adds them to the VTNA rule table (`awardMilestone` already skips `credit_wallet` at reward 0). The coach
reads the milestone **rows** (`source_type='milestone'`), not `oasis_events`; there is no `onboarding.coach.milestone_reached` event.
Slice 1 confirms that member-facing Autopilot lists filter out `source_type='milestone'` rows (reward-0 milestones add completed rows there).

**Done-by-Vitana never earns VTNA — by construction.** VOA never writes to any table a paid milestone checker counts
(`relationship_edges`, group memberships, event participants, matches, referrals, topic profile, Index scores). Any connection,
group join or RSVP is made by the member's own action afterwards. VOA writes only `chat_messages` (tagged
`metadata.source='voa_*'`, `metadata.done_by_vitana=true`) and `profile_posts` (`post_kind='inspiration'`), which no paid checker
counts. The simulation asserts zero VTNA from every VOA flow.

### 4.4 The activation ladder (what it teaches, in order)
Each rung = one tiny action with an immediate benefit. Wording is composed by the model from an *intent* (rule 41),
never hardcoded; push/in-app titles are `tt()` catalog keys in all 11 locales.

| Days | Theme | Rung → benefit |
|---|---|---|
| 0 | Meet Vitana | After the Founding celebration and the wizard: the Audiobook's "Play Episode 1" (T255) is the first step — VOA does not repeat it. ORB asks ONE question ("what brought you here?") after the first episode. |
| 0–1 | First value | Set a goal (Life Compass) or a 3-question Index baseline → first Vitana Index number. Ask push permission *after* this moment of value. |
| 1–3 | Talk to Vitana | "Try asking me: …" (3 contextual sample asks). Diary voice note (30 s). |
| 3–7 | First people | Vitana-hosted intros (§4.5); join 1–2 groups incl. Alle Beisammen; see 1 event. |
| 8–30 | Habit | Morning brief opt-in, reminders, Did-You-Know tour. First inspiration post offer on the first Friday (§4.6). One new feature per week, max. |
| 31–60 | Deepen | Audiobook episode a day (1/day pace), events in real life, first invite of a friend. |
| 61–90 | Own it | Recap ("your 60 days"), switch to Full mode, graduate; hand over to normal Autopilot. |

Back-off: ×2 gap after each ignored touch; stop after 3 consecutive ignores until the member re-engages. Push is a nudge to open the app/ORB, not content.

### 4.5 Shy-member social bridge ("let me do it for you")
1. **Vitana-brokered intro (consent both ways).** Vitana proposes: "Anna also loves trail running and is in Berlin — want me to say hi for you?" On yes → drafted DM read back → sent, framed with the shared reason. Proposals are stored via `proposeToMember` but **surfaced through the VOA card and ORB rung**, not the Community Autopilot queue; acceptance is measured separately.
2. **Reason-rich prompt to the existing member**: enrich the existing new-member card copy with the shared reason. **In-app card only — no push, no new surface (owner decision).** Off during the pilot.
3. **Mariia Maksina is the communication centre (owner decision).** At a milestone Vitana offers "Shall I tell Mariia you're onboarded and happy to join the Longevity Journey?" → on yes, read-back + send. Mariia receives max **5 onboarding messages per day**; the rest go into one daily digest (owner decision).
4. **Alle Beisammen welcome thread**: weekly "new faces" post naming the week's newcomers (with their consent) and one easy question. Off during the pilot.
5. **Welcome DM from Mariia (owner decision)** — seed wording: "So nice to see you with us. Welcome, and I'm looking forward to many beautiful moments together on our joint Longevity Journey!"
   - Sent **only by the gateway tick** (never a DB trigger): cohort + pilot allowlist + strict exclusion. It is **not** a touch and does not use the touch ledger; it has its own claim (`claim_mariia_welcome` RPC: unique per member, `status pending|sent|failed`, one bounded retry on `failed`), so a failed send is retried once and never lost silently or sent twice.
   - `tt()` catalog entry in all 11 locales, du-form (a written message from a person; rule 41 does not apply, the catalog rule does).
   - `metadata.source='voa_mariia_welcome'`, `done_by_vitana=true`; sender `VOA_WELCOME_SENDER_USER_ID` (config); Mariia approves the wording and the automation once (recorded in the VTID).
   - Pilot: only Jovana, Alex Red, Alex Blue receive it; Mariia never messages herself.
6. Low-risk first: react to a post, join a group, RSVP — before DMs.
Match source: whichever of `daily_matches`/intent matches is live (verify the live schema first; no new match system).

### 4.6 Inspiration posts — Autopilot prepares posts on the member's behalf (owner request 2026-10-01)

**Why.** Shy new members don't post. A prepared first post shows that a positive post is easy and people respond.

**What.** A quote card in the feed: a short quote, who said it, an optional line from the member ("Have a wonderful weekend, everyone! ☀️"), calm branded background. Always positive.

**Occasions (max 1 offer per member per week):** Friday afternoon (weekend wish), Monday morning (fresh start), a milestone (celebration), seasonal moments.

**Quote library — curated, never invented.** `onboarding_quote_library`; the model picks an entry and writes the member's line around it; it never writes or "remembers" a quote (NEVER rule 31).
- Historical figures: public-domain originals; **each locale's translation stores its source and licence** (modern translations can be copyrighted).
- Happy songs: **title + artist** with a one-line feeling in our own words, never lyric lines (lyrics only after a legal check).
- Fields: text per locale, author, source, licence, theme tags, `status draft → approved`; the **owner (admin)** approves.
- **First seed is small:** ~30 approved entries in de + en (enough for the 90-day window at ≤1 post/week). A member whose locale has no approved entry gets **no offer** rather than an untranslated quote; more locales follow.

**Flow (consent per post).** Vitana offers a draft (ORB or Home card) → the member taps **Post**, **Change** or **Not now**; nothing is posted without that tap. Next day Vitana reports likes/replies, which becomes the next social step. A "created with Vitana" label keeps it honest.
**Automatic Friday posts (owner decision O2, 2026-10-05).** After **3 posts the member approved themselves**, Vitana offers a
"post for me automatically on Fridays" switch (Autopilot settings, off by default; the member switches it on, and off again any time).
When on: one weekend-wish post per Friday from the approved library, same guardrails as above (label, no push, feed cap, ≤1/week, no
VTNA); the automatic post is that day's touch. Vitana shows what it posted, with a one-tap delete, on the Home card and in the next ORB
conversation (not a second touch). Automatic posts pause when the member has not opened the app for 7 days, says "stop", opts out, or
leaves the 90-day window; the switch ends with VOA unless the member keeps it in Autopilot settings. A post deleted within 24 h counts
as an ignore (back-off); 2 deletions in a row switch the automation off, and Vitana asks again once, not before 30 days. During the pilot automatic posts are
author-only like every pilot post.

**Guardrails.**
- `profile_posts.post_kind` column added by a **vitana-v1** migration; only the service role may set `post_kind='inspiration'` (a trigger rejects it from `authenticated`), and `trg_notify_community_post` skips that kind: feed only, no tenant push (owner decision).
- Going public later uses an `is_public` false→true UPDATE, which does not fire the INSERT trigger — so no push either way.
- Tenant feed cap (proposed 3/day, spread out); max 1 post per member per week; counts as the day's onboarding touch.
- Never health claims, politics, religion-specific or sad content.
- Service/test accounts never post; pilot posts are author-only (owner decision).
- Reuse `Inspiration.tsx` templates, `profile_posts`, `NewsFeedItemCard`.

### 4.7 Channels, budget and scheduling
- **One touch budget.** New table `onboarding_touch_ledger (user_id, local_day, action_key, channel, status pending|sent|failed, unique(user_id, local_day))`, claimed through one SECURITY DEFINER RPC `claim_onboarding_touch` (service role only; same pattern as `claim_due_audiobook_reminders`). A unique violation means "already touched today" and nothing is sent. A `failed` send may be retried once the same day; otherwise the slot stays used. DB-enforced and race-proof (two instances or schedulers cannot double-send).
- **"Day" is the member's local date** (from their timezone, as the Audiobook reminder uses), everywhere in VOA: the ledger, Friday/Monday occasions, quiet hours. The pacer keeps its own UTC day; VOA must pass both.
- **Pacer:** add `onboarding_coach` to `ProactiveSurface` **and** a migration that reads the live `user_proactive_touches.surface` CHECK and widens it to the full TypeScript union plus `onboarding_coach` (the repo constraint lists 7 of today's 11). The list is built from the union **and** a read-only `SELECT DISTINCT surface` of the live table, added `NOT VALID` and then `VALIDATE`d, so live rows can never abort the migration. VOA treats a failed `recordTouch` as a failed touch: the ledger row is marked `failed` and nothing is sent. For a quiet member (cap 1) VOA's touch *is* their one touch that day.
- **Audiobook reminder gives way:** on a day the member has the Audiobook reminder enabled and today's episode is not finished — **or the reminder was already sent today** (`metadata.audiobook_reminder.last_sent_local_date = today`) — the day belongs to the reminder — VOA sends no push and no in-app nudge (the Home card and the ORB rung inside a member-opened conversation still work). No change to `claim_due_audiobook_reminders`.
- **Rewards reminders:** the rewards plan does not send reminders today; when it does, writing to `onboarding_touch_ledger` for members in the 90-day window is a dependency recorded for that plan, not built by VOA.
- **What counts as a touch:** VOA push, VOA in-app nudge, Vitana DM sent on the member's behalf (on their yes), inspiration-post offer, an automatic Friday post. Not a touch: Home card render, ORB rung inside a conversation the member opened, replies from real people, the Mariia welcome DM (one-time, own claim §4.5.5).
- **ORB**: `onboarding_coach` greeting rung after `first_time_welcome` for cohort members on the community profile + a context provider (mentions the next step once). Never talks over an Audiobook episode. Kill switch like the newday rungs.
- **Home (FE)**: "Dein Start / Your start" card inserted **before the first feed item**, rendered only for cohort members (established members' feeds unchanged). When the next step is "listen", it points at the Longevity Journey card instead of showing its own player.
- **Push/in-app**: catalog types `onboarding_nudge`, `onboarding_intro_proposal`, `onboarding_recap` in `notification-controls/notification-catalog.ts` (`unverified → ready` after the locale check).
- **Email: out of scope (owner decision).**
- **Scheduler**: `POST /api/v1/scheduled-notifications/onboarding-coach-tick` behind `requireScheduledNotificationsAuth` (VTID-04677); EventBridge script following `setup-eventbridge-daily-feature-tip.sh`, reading `vitana/gateway/prod/internal-token`, targeting production only. No DB trigger on `user_tenants` (that table already carries the welcome and seed triggers).

### 4.8 Observability
OASIS events for real state transitions only: `onboarding.coach.stage_changed`, `.touch_sent`, `.intro_proposed/accepted/replied`,
`.inspiration_post_offered/posted/declined`, plus **one aggregate `onboarding.coach.tick_completed`** per tick with counts. Per-member
skip reasons go to the coach's own decision log, never as one OASIS event per member per tick (NEVER rule 10). Milestones come from the milestone rows. Funnel reads `/analytics/audiobook`
for listen-through and day-7 return and adds the social metrics: % talking to Vitana in 24 h, % with push on, % with ≥1 reply in
7 days (target >3× baseline), % in ≥1 group, churn before day 7, inspiration-post acceptance and responses.

## 5. Delivery slices (each = own VTID + PR after the owner approves this plan)

| # | Slice | Repo | Done criteria (besides CI) |
|---|---|---|---|
| 0 | Fix-first §3 | platform + v1 | each its own staging test |
| 1 | Coach engine, `onboarding_coach_state` + `onboarding_touch_ledger` + claim RPCs, milestone extensions, pacer surface + CHECK migration, strict exclusion, **shadow mode**, tick endpoint (own token check, refused on staging), read-only `GET /api/v1/onboarding-coach/status` | platform | regression suite `test:onboarding` (simulation §6.1); Jest: tick 401 without token / 503 without configured token / refused on staging; **read-only** staging spec: `GET …/onboarding-coach/status` reports `mode: disabled-on-staging` (never a POST), `/alive` |
| 2 | FE "Your start" card, push priming after the first episode, What's New entry | v1 | RTL + du-form; screenshots desktop+mobile; read-only staging spec: the card does not render for the (non-cohort) test account |
| 3 | ORB rung + context provider + sample asks | platform | `npm run test:roles` green (rule 42h); community profile only |
| 4 | Mariia welcome DM + social bridge (both-sides pilot allowlist) | both | simulation: zero rows to anyone outside the allowlist; zero VTNA from VOA flows |
| 5 | Inspiration posts: library + admin review, offer flow, `post_kind` (vitana-v1 migration), trigger skip, feed cap | both | simulation: no tenant push, cap, no repeat, `authenticated` cannot set `post_kind` |
| 6 | Day 8–90 cadence, recap | platform | (the daily shadow tick's EventBridge job moved forward to VTID-05039) |
| 7 | Funnel dashboard + weekly report | platform | |

Every slice that deploys carries `docs/validation/<VTID>/staging-tests.json` with **read-only** specs (Staging Verification Gate, rules 46–48); anything needing a write is proven by the CI simulation.

## 6. Test run — without violating the no-production-writes rule

Staging and previews share the **production Supabase**, so:

1. **Simulation (CI, in-memory DB + fake clock).** Golden scenarios: eager user; shy user ignoring 3 nudges; intro accepted + reply;
   "stop"; veteran (nothing); service-bot (nothing); exclusion lookup fails (tick skipped); two ticks racing (one send); Friday offer →
   post with no tenant push; pilot mode with a non-allowlisted counterparty (nothing reaches them); VOA-caused connection (no VTNA).
   Fast-forwards 90 days; asserts the touch ledger, pacer, quiet hours, back-off, milestone progression, locale keys.
2. **Shadow mode on real signups (production gateway only).** The coach writes only its own tables (`onboarding_coach_state`, decision
   log) in the production database and **sends nothing**. We compare "what Vitana would have done" with real behaviour. This is stated in the slice-1 VTID.
3. **Live pilot on four named accounts (owner decision):** Mariia, Jovana, Alex Red, Alex Blue — from the production gateway, both sides
   allowlisted, `metadata.source='voa_pilot'`. Pre-flight (read-only): user_ids, tenure, tenant, push tokens. **Before the first live send the
   owner sees the exact recipients and message intents and says go.**

## 7. Risks
- R1 Over-nudging → churn: DB-enforced 1 touch/day, pacer, back-off, stop, shadow first.
- R2 Social trust: both-side consent; pilot closed on both sides; never expose test/service accounts.
- R3 Parallel match systems: verify the live schema; no new one.
- R4 Push infra: FCM project `lovable-vitana-vers1` is hardcoded while GCP is decommissioned — verify delivery before promising push.
- R5 Topic content is German-first; check en/es/sr/ar coverage; du-form; RTL.
- R6 Lazy `user_journey` row and stale "Maxina" seed copy — §3.
- R7 Greeting files are high-risk: minimal rung change, `test:roles`, characterization tests.
- R8 Inspiration posts: no push (trigger skip), curated quotes with per-locale licence, titles not lyrics, feed cap, per-post consent + label.
- R9 Staging and production share one database: live only from the production gateway; DB-enforced idempotency.

## 8. Decisions

Owner (2026-09-29 / 2026-10-01):
1. Cohort: new registrations **and** members who joined in the last 30 days.
2. Mariia Maksina is the communication centre; Jovana, Alex Blue, Alex Red are the pilot accounts (real members, see 13). No Welcome Hosts pool.
3. Veteran-side prompt: existing in-app card only.
4. Live pilot with real messages to Mariia, Jovana, Alex Red, Alex Blue (allowlist-enforced).
5. Email dropped.
6. Inspiration posts: Autopilot prepares positive quote-card posts on the member's behalf.
7. Mariia's inbox: max 5 onboarding messages per day; the rest in one daily digest.
8. Pilot roles: Jovana, Alex Red, Alex Blue = new members; Mariia = receiver.
9. Pilot inspiration posts are visible to the author only.
10. Inspiration posts send no push to the community.
11. Quote-library entries are approved by the owner (admin).
12. (VTID-04864/04878) Done-by-Vitana never earns VTNA; `onboarding_complete` pays at signup.

13. **(O1, 2026-10-05)** Jovana, Alex Red and Alex Blue are **real members**, used as pilot accounts. They are not registered in the test-account lists; the both-sides pilot allowlist is the guard.
14. **(O2, 2026-10-05)** The automatic "post for me on Fridays" switch is wanted (§4.6: offered after 3 self-approved posts, member opts in, off any time).

Open for the owner: none.

## 9. Coordination with parallel work

### 9.1 Audiobook (VTID-04760…04763) — merged
| # | Overlap | VOA rule |
|---|---|---|
| C1 | Season 0 prepends T255–T260 | Milestones use **topic ids**, never session numbers; day 0 = Episode 1 (T255). |
| C2 | First-time welcome points at Episode 1 | VOA's rung comes after it and never repeats that invitation. |
| C3 | Wizard i18n + "Play Episode 1 / Later" done | VOA does not touch the wizard; push priming after the first episode. |
| C4 | `LongevityJourneyCard` plays today's episode | One onboarding card: VOA points at it when the step is "listen". |
| C5 | Daily episode reminder via `reminder_due` | Counts as that day's touch (§4.7). |
| C6 | 1 episode/day | Ladder pace = 1 episode/day. |
| C7 | ORB stays closed while an episode plays | VOA never talks over an episode. |
| C8 | Greeting code (`compute-greeting-decision.ts`, `first-time-welcome/*`) | Slice 3 rebases on merged code; `test:roles`. |
| C9 | `/analytics/audiobook` | VOA funnel reads it. |
| C10 | Naming: Audiobook / Hörbuch, episodes | VOA copy uses the same words. |

### 9.2 VTNA rewards (VTID-04809/04864/04878) — live
- Inspiration posts and every done-by-Vitana action earn nothing (decided; enforced by `done_by_vitana` tagging, §4.3).
- Reward reminders write to the same touch ledger (§4.7).
- Milestones are shared: one detector (`milestone-service.ts`), one event (`user.milestone.reached`).

### 9.3 Already merged, no conflict
What's New automation (VTID-04733/04739); new-member card (PR #1170); Community Autopilot v2 (`proposeToMember` used for storage only).

