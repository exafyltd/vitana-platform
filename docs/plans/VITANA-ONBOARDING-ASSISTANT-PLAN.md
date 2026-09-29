# Vitana Onboarding Assistant (VOA) — Plan v1

Status: DRAFT for owner review · 2026-09-29 · VTID: VTID-04744
Repos: `vitana-platform` (engine, ORB, notifications) + `vitana-v1` (Home card, permission priming, i18n)

## 1. Problem

A member who registered yesterday gets the same product as one who registered 8 months ago. The system is big
(551+ screens, Autopilot, Journey, Index, community), new members are shy, don't ask, don't test — and disappear.
The one social mechanism we have (automatic "Hello" DM from the new member to everyone) gets almost no replies:
strangers get a message from someone they know nothing about.

Goal: for the first 90 days, a proactive, tenure-aware assistant that (a) teaches by doing, (b) makes the member
talk to Vitana within day 0–1, (c) does the socially scary steps *for* the member, with consent, and (d) never
nags. Established members are untouched.

## 2. What already exists (research findings)

Most parts are built. What's missing is an **owner that decides "what's the next best step for this member today"**
and drives every channel from that one decision.

| Building block | Where | State |
|---|---|---|
| Tenure model day0…day180plus, `active_usage_days` | `gateway/services/guide/journey-experience.ts`, `types.ts` | live, unused for onboarding |
| First-time-welcome ORB rung (prio 95, fires once) | `assistant-continuation/providers/first-time-welcome/` | live; depends on lazily-created `user_journey` row |
| Journey guide / guided-topic narration providers | `assistant-continuation/providers/journey-guide.ts`, `guided-topic-narration.ts` | live |
| 254 topics / 94 sessions (T001–T254); T251–T254 = opening onboarding sessions | `journey_checklist_topics`, `routes/journey-checklist.ts`, tool `narrate_guided_session` | live (German scripts, translated en/es/sr) |
| Guided vs Full mode, `onboarding_status` | `user_guided_journey_state`, `routes/guided-journey.ts`; FE `GuidedModeProvider` (mobile only) | live |
| Journey Foundation steps (life compass, diary, index, calendar…) | `services/journey-foundation/`, `user_journey_foundation` | live |
| 8-row `onboarding_*` Autopilot seed on signup | trigger `seed_onboarding_autopilot_on_primary_membership` | live; old rows carry "Maxina" copy |
| Welcome-chat DM fan-out (DB trigger) | `fire_welcome_chat_on_membership()` | live, **regressed** (see §3) |
| Presence pacer (2 touches/day cap, per-surface) + pause tool | `services/guide/presence-pacer.ts` | live — the mandatory gate |
| Notifications: push (FCM+Appilix), in-app, prefs, quiet hours, admin type controls | `notification-service.ts`, `notification-controls/` | live |
| Connection proposals with consent (`proposeToMember`), chat-on-behalf tool with read-back | `community-autopilot/automation-proposals.ts`, `orb-tools-shared.ts` | live |
| Matches / intents / groups / "Alle Beisammen" | `routes/matchmaking.ts`, intent engine (flag), `chat-groups.ts` | live but parallel systems |
| FE wizard (video + speech + name/handle) | `OnboardingWelcome.tsx`, `OnboardingSpeech.tsx` | live; speech hardcoded English; completion = localStorage + name/handle |
| FE Home card slots, `DidYouKnowCard`, Journey ring | `Home.tsx renderInterleavedFeedItems` | live — natural home for a VOA card |
| What's New pipeline | `src/whats-new/entries/` | empty |

Dead / disconnected (do not build on):
- `/auth/login` hooks (welcome notification, first_login recs, TS welcome-chat) — community app never calls it.
- AP-1301…1307 onboarding automations — need `user.signup.completed` + `DEFAULT_TENANT_ID` (staging only); AP engine dark since ~Aug.
- Community Autopilot: 93% rejected/expired, 0 activations in 30 days (2026-09-24 plan) — suggestions aren't landing.
- `user_journey` (FE types) `onboarding_stage`, `welcome_to_vitana` notification: never reach members.
- Welcome reply rate: **not measured anywhere.**

## 3. Fix-first list (small, independent PRs, before VOA)

1. **Welcome trigger regression.** `20260917084341_vtid_03990` re-created `fire_welcome_chat_on_membership()` from the old body and
   overwrote the "Alle Beisammen" fix (uncapped group enrollment before early-return). New migration must merge both
   (service-bot guard + metadata cap + enrollment first). Read the live function definition first.
2. **Guarantee `user_journey` row at signup** (trigger on `user_tenants`, or call `ensureUserJourneyRow` in the seed
   trigger) so `is_first_session` and tenure are reliable.
3. **Server-side `onboarding_completed_at`** (profiles/app_users) — today completion is per-browser localStorage.
4. **Measure the baseline**: SQL report of reply rate for `metadata->>'source'='welcome_chat'`, D1/D7 return, and
   time-to-first-ORB-conversation for the last 60 days of signups. Read-only. This is the number VOA must beat.

## 4. Design

### 4.1 Principle
One brain, many mouths. A new **Onboarding Coach service** computes per-member *state* and the *single next best
action*; existing channels (ORB, Home card, push, in-app, Vitana DM) only render it. Every outbound touch goes
through the presence pacer. Nothing existing is deleted; the hello DM stays.

### 4.2 Cohort & gating
- Cohort (owner decision 2026-09-29): registrations after `VOA_ROLLOUT_DATE` **plus members who joined in the last 30 days at rollout** (they enter at their real tenure stage, not day 0). Tenure < 90 days. Everyone else never sees VOA.
- **Pilot allowlist (hard-enforced in code):** during the live pilot the coach may only act for Mariia Maksina, Jovana, Alex Red and Alex Blue (`VOA_PILOT_USER_IDS`, resolved read-only). Any other user stays in shadow mode. Removing the allowlist is a separate, explicit owner step.
- Flag `FEATURE_ONBOARDING_ASSISTANT_ENV` via `isFeatureLive` (`off | staging-only | staging+prod`), plus modes
  `shadow` (compute + log, send nothing) and `live`.
- Off-ramps: member says "stop" (existing `dismissal-tool`), completes the ladder, or day 90.
- Exclude `service_bot_accounts` / `fetchExcludedTestServiceAccountIds` everywhere (rules 43–45).

### 4.3 State: `onboarding_coach_state` (per user)
`user_id, tenant_id, stage (d0,d1,d2_3,d4_7,d8_30,d31_60,d61_90,done), milestones jsonb, last_touch_at, next_action_key,
snoozed_until, shy_score, opted_out_at`. Milestones are **derived from live tables** (like Journey Foundation), not
self-reported: first ORB conversation, profile complete, avatar, interests ≥3, first diary entry, life compass set,
Index baseline, push permission granted, T251–T254 heard, first group joined, first DM sent, first DM *reply received*,
first event RSVP, first invite.

### 4.4 The activation ladder (what it teaches, in order)
Each rung = one tiny action with an immediate benefit. Wording is composed by the model from an *intent* (rule 41),
never hardcoded; push/in-app titles are `tt()` catalog keys in all 11 locales.

| Days | Theme | Rung → benefit |
|---|---|---|
| 0 | Meet Vitana | Wizard → ORB says hi, asks ONE question ("what brought you here?"), heard T251 "Starte deine Longevity-Reise". Benefit: she now knows you. |
| 0–1 | First value | Set a goal (Life Compass) or answer a 3-question Index baseline → member sees a first Vitana Index number. Ask push permission *after* this moment of value, not at signup. |
| 1–3 | Talk to Vitana | "Try asking me: …" (3 contextual sample asks, tied to interests). Diary voice note (30 s). T252–T254. |
| 3–7 | First people | Vitana-hosted intros (§4.5); join 1–2 groups incl. Alle Beisammen; see 1 event. |
| 8–30 | Habit | Daily/weekly rhythm: morning brief opt-in, reminders, Autopilot slots, Did-You-Know tour (existing 30-usage-day curriculum). One new feature per week, max. |
| 31–60 | Deepen | Guided sessions pace (existing daily goal), events/meetups in real life, first invite of a friend. |
| 61–90 | Own it | Recap ("your 60 days"), switch to Full mode, graduate; hand over to normal Autopilot. |

Cadence: at most 1 proactive onboarding touch/day (pacer default cap is 2 — VOA takes 1 of them), quiet hours respected,
backs off (×2 gap) after each ignored touch, and stops after 3 consecutive ignores until the member re-engages.
Push is a nudge to open the app/ORB, not content.

### 4.5 Shy-member social bridge ("let me do it for you")
Problem with today's hello: sender is a stranger, no reason to answer. Keep it; add a warm layer:
1. **Vitana-brokered intro (consent both ways).** Vitana proposes to the new member: "Anna also loves trail running and is
   in Berlin — want me to say hi for you?" On yes → drafted DM shown/read back → sent (existing confirm flow),
   framed with the *shared reason*. Replies land in the normal inbox with a push.
2. **Reason-rich prompt to the existing member**, not a bare DM: the existing in-app card ("New here: Sam — also into sleep optimisation. Say hi?"). **In-app card only — no push, no new surface (owner decision).** Reuse the existing new-member card; only enrich its copy with the shared reason.
3. **Mariia Maksina is the communication centre (owner decision).** Instead of a pool of hosts, Vitana routes onboarding communication through Mariia: when a member reaches a milestone Vitana offers "Shall I tell Mariia you're onboarded and happy to join the Longevity Journey?" and, on yes, sends that chat message (read-back + confirm flow). Mariia is the human welcome point; her inbox load needs a cap/digest (max N onboarding messages/day, grouped) so she isn't flooded. Welcome Hosts pool is dropped for v1.
4. **Alle Beisammen welcome thread**: weekly "new faces" post by Vitana that names the week's newcomers (with their consent) and asks one easy question.
5. Low-risk first: react to a post, join a group, RSVP — before DMs. Ladder order reflects shyness.
Consolidate on one match source (see risk R3): use `daily_matches`/intent matches whichever is live per query of the live schema.

### 4.6 Channels
- **ORB**: new greeting rung `onboarding_coach` between `first_time_welcome` and `journey_guide` for cohort members; also a `onboarding_coach`
  context provider so any conversation can mention the next step once, naturally. Kill-switch like the newday rungs.
- **Home (FE)**: new "Dein Start / Your start" card in `cardSlots` (top, above Vitana Index): progress ring, the ONE next action, "later" + "stop".
- **Push/in-app**: new catalog types (`onboarding_nudge`, `onboarding_intro_proposal`, `onboarding_recap`) registered in
  `notification-catalog.ts` (unverified→ready after locale check; DB guard otherwise leaves them OFF).
- **Email: out of scope (owner decision: outdated).**
- **Scheduler**: HTTP tick `POST /api/v1/scheduled-notifications/onboarding-coach-tick` + EventBridge script (pattern of
  `setup-eventbridge-daily-feature-tip.sh`). *Not* the AP engine (dark), *not* an in-process loop (double-fire with >1 instance).
  Signup-time kick-off uses a DB trigger on `user_tenants` (bypass-proof, precedent exists).

### 4.7 Observability
OASIS events (`onboarding.coach.stage_changed`, `.touch_sent`, `.touch_skipped{reason}`, `.milestone_reached`, `.intro_proposed/accepted/replied`)
+ admin funnel view. Success metrics vs the §3.4 baseline: D1/D7/D30 return, % who talk to Vitana in 24 h, % with push on,
% with ≥1 reply in 7 days (target: >3× baseline), % in ≥1 group, churn-before-day-7.

## 5. Delivery slices (each = own VTID + PR, each shippable behind the flag)

| # | Slice | Repo | Notes |
|---|---|---|---|
| 0 | Fix-first list §3 | platform + v1 | independent |
| 1 | Coach engine + state table + milestone derivation + `tt()` keys + pacer integration + **shadow mode** + tick endpoint | platform | Jest incl. simulation harness (§6) |
| 2 | FE: "Your start" card, i18n'd wizard speech, push-permission priming after first value, nav-registry/What's New entry | v1 | RTL + du-form; screenshots desktop+mobile |
| 3 | ORB rung + context provider + sample-ask prompts | platform | extend greeting characterization tests; kill switch |
| 4 | Social bridge: intro proposals, veteran prompt, Alle Beisammen thread; Mariia-centred flow | both | consent + rate limits; test-account exclusion |
| 5 | Day 8–90 cadence, recap, EventBridge script | platform | no email |
| 6 | Funnel dashboard + weekly report | platform | |

Regression rule to add with slice 1 (like 04456/04465): `test/vtid-XXXXX-onboarding-assistant-regression.test.ts`, `npm run test:onboarding`.

## 6. Test run — how we do it without violating the no-production-writes rule

Constraint (CLAUDE.md): staging and previews share the **production Supabase**; a test signup + sends would reach real people.
So the "test run with a new registered user" is done in three safe layers:

1. **Simulation (CI, in-memory DB + fake clock).** Golden scenarios: (a) eager user, (b) shy user who ignores 3 nudges,
   (c) user who accepts an intro and gets a reply, (d) user who says "stop", (e) veteran (must get nothing), (f) service-bot account (must get nothing).
   Fast-forwards 90 days; asserts touches/day cap, quiet hours, back-off, milestone progression, text keys in all locales.
2. **Shadow mode on real signups (read-only).** Flag `shadow`: the coach runs for each real new registration, writes only its own
   decision log, sends nothing. We review "what would Vitana have said/done" for the next real signups and compare to their actual behaviour.
3. **Live pilot on four named accounts (owner decision 2026-09-29):** Mariia Maksina, Jovana, Alex Red, Alex Blue.
   Real sends (Vitana DMs, push, in-app) are enabled **only** for these four via the code-level allowlist; Jovana and the two Alexes act as the test
   "new members", Mariia as the receiving centre. They are known to the owner and are not registered in the service-bot lists on purpose (they must receive
   real messages) — so the allowlist, not the bot lists, is the guard. Sends carry `metadata.source='voa_pilot'` for filtering/cleanup.
   Pre-flight (read-only): resolve their `user_id`s, confirm tenure/primary tenant, confirm push tokens. **Before the first live send I will show the exact
   recipients + message intents and wait for a go**, because this writes to the shared production Supabase. Rows are only created for these four users;
   nothing fans out to other members (the welcome trigger is untouched and the coach never calls it).
   A dedicated isolated Supabase remains the long-term fix for synthetic end-to-end runs.

## 7. Risks

- R1 Over-nudging → churn. Mitigated by cap 1/day, back-off, hard stop, opt-out, shadow-first.
- R2 Social spam / trust: intros only with both-side consent; veteran prompts opt-in and capped; never expose test/service accounts.
- R3 Parallel match systems (`matches_daily` route vs live `daily_matches`; intent engine flag): verify live schema first; do not add a fifth.
- R4 Push infra: FCM project `lovable-vitana-vers1` is hardcoded while GCP is decommissioned — verify push actually delivers before promising it.
- R5 Journey/T-topic content is German-first scripts; check en/es/sr/ar coverage; du-form; RTL for Arabic.
- R6 `first_time_welcome` lazy row and stale seed copy ("Maxina") — handled in §3.
- R7 Greeting ladder still inline in `orb-live.ts` (high-risk file): keep the rung change minimal and characterization-tested.

## 8. Decisions (owner, 2026-09-29) — resolved

1. Cohort: new registrations **and** members who joined in the last 30 days.
2. Mariia Maksina is the communication centre ("tell Mariia you're onboarded and happy to join the Longevity Journey"); Jovana, Alex Blue, Alex Red are the test accounts. No Welcome Hosts pool.
3. Veteran-side prompt: existing in-app card only, not extended.
4. Live pilot with real messages to Mariia, Jovana, Alex Red, Alex Blue (allowlist-enforced).
5. Email dropped.

Open (small): (a) Mariia's daily inbox cap / digest size; (b) which of the four plays "new member" vs receiver in each scenario (proposed: Jovana, Alex Red, Alex Blue = new members; Mariia = receiver).
