# Plan Sparring record — VTID-04892 (Vitana Onboarding Assistant, plan v3)

| | |
|---|---|
| Plan | `docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md` (v3) |
| Change class | standard |
| Initial plan hash (round 1) | `f8c490b774fc130e3fe6ced32e51617044e9b367ce1d1149066ee13c1bb095dc` |
| Round 2 plan hash | `1e95ed1a4b2b7e8cb20727e8e5f550cab093ede6d8024415d1efabcb044ea4ef` |
| Round 3 plan hash | `49ecee58dc1de01e10a6e6e481d77ad0e2dcd13d2c7d074962c8040bc9cf645b` |
| **Final plan hash** | **`0e9d13e507d6e22b405599f7d53eb5a92956b737510afbfd0c44b04da920df3c`** (sha256 of the text between the plan markers, which is `"\n\n" + <committed plan file> + "\n"`; reproduce with `python3 -c "import hashlib;print(hashlib.sha256(('\\n\\n'+open('docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md').read()+'\\n').encode()).hexdigest())"`) |
| Verdict | **CONVERGED** (round 3), **CONFIRMED-CONVERGED** on the final text (confirmation pass) |
| Owner approval | in chat, 2026-10-05 ("Yes"); binding click `POST /api/v1/plans/spar/1583d683-eff5-42ba-b5d0-5b5da9578e8a/approve` pending |
| DB record | `plan_sparring_sessions.id = 1583d683-eff5-42ba-b5d0-5b5da9578e8a` (attested tier, `pending_human_approval`); allocation logged by the gate (log mode) as `verdict_pending_human_approval` |
| Partner | one read-only partner across all rounds (same context). The `plan-sparring-partner` agent type was not loaded in the session, so the skill's documented fallback ran: a read-only general-purpose agent with that agent file's instructions, on the session's Opus alias — **not** the Bedrock Claude Opus 4.6 of rule 53. |
| Owner decisions during sparring | O1 (2026-10-05): Jovana, Alex Red, Alex Blue are real members, used as pilot accounts. O2 (2026-10-05): the automatic Friday-post switch is wanted. |
| Deferred to slice 5's own sparring | auto post skips a Friday the Audiobook reminder owns; a kept switch after day 90 is inherited by normal Autopilot with the same guardrails; slice-5 simulation scenarios for the pause rules, delete-as-ignore and auto-off after 2 deletions. |

Each later slice gets its own sparring of its exact scope before its own VTID (one sparring record binds one VTID).


---

## Round 1 — partner findings (verbatim)

## Verified premises
- VTNA reward rule table exists; done-by-Vitana (including Vitana-drafted posts) never earns VTNA; invites pay 1,000 each with a one-time 10,000 → TRUE — `services/gateway/src/services/rewards/vtna-reward-rules.ts:1-15, 92-112, 115-117`
- Presence pacer is the gate, with a default cap of 2 touches a day → PARTIAL. The cap depends on `proactive_presence_level`: quiet=1, balanced=2, engaged=3. It is also one touch per surface per day, and the `ProactiveSurface` union has no onboarding surface yet — `services/guide/presence-pacer.ts:8-13, 27-54, 156-172`
- `isFeatureLive` supports `off | staging-only | staging+prod` through `FEATURE_<NAME>_ENV` → TRUE — `services/gateway/src/services/feature-flags.ts:62-87`
- The welcome-trigger regression in §3.1 is real: 03990 brought back the old body, with enrollment after the `>1000` early return and a hard `< 100` cap on every system group, so "Alle Beisammen" stops enrolling at 100 → TRUE — `20260917084341_vtid_03990…sql:157-165` vs `20260625000000_alle_beisammen_chat_group.sql:16-21, 81-97`. No later migration fixes it.
- `trg_notify_community_post` sends to the whole tenant → TRUE. It fires only `AFTER INSERT … WHEN (NEW.is_public = true)` — `vitana-v1/supabase/migrations/20260630120000_notify_on_community_publish.sql:36-54`
- `profile_posts` has an `is_public` flag (pilot posts can be author-only); there is no `post_kind` column → TRUE (the column has to be added) — `vitana-v1/supabase/migrations/20260210135042_…sql:3-14, 22-30`. Note that the table and trigger migrations live in **vitana-v1**, not in the platform `supabase/migrations` listed in the plan's scope.
- FCM project `lovable-vitana-vers1` is hardcoded → TRUE — `services/gateway/src/services/notification-service.ts:27-32`
- Notification catalog has the `unverified`→`ready` text states → TRUE. The path is `notification-controls/notification-catalog.ts:11-20`, not `notification-catalog.ts` at the top level.
- EventBridge pattern script exists → TRUE — `scripts/aws/setup-eventbridge-daily-feature-tip.sh`. Since today's HEAD (VTID-04677, `7ad4276c`), every `/scheduled-notifications/*` POST needs `X-Gateway-Internal`.
- `first_time_welcome` has priority 95; `ensureUserJourneyRow` is only called lazily, from the live session → TRUE — `first-time-welcome/index.ts:53-56`, `orb/live/session/live-session-controller.ts:2516-2538`
- `fetchExcludedTestServiceAccountIds` covers both allowlists → TRUE, but it **fails open**. A strict variant also exists — `lib/excluded-test-service-accounts.ts:23-40, 49-57`
- `proposeToMember`, `dismissal-tool.ts`, `Inspiration.tsx`, `NewsFeedItemCard`, `NewMemberCard` (PR #1170) all exist → TRUE
- "What's New pipeline … empty" → FALSE. `vitana-v1/src/whats-new/entries/` already holds 5 entries, including `audiobook-listening-mode.json`.
- §9.1 "Audiobook … not merged yet" → FALSE. It merged as `b230482` (#1192, VTID-04760…04763) on vitana-v1 main.
- Home card goes "top, above Vitana Index" in `cardSlots` → PARTIAL. `cardSlots` are inserted *after* feed item index *n*, so slot 0 renders after the first feed item, not at the top — `src/pages/Home.tsx:337-370`
- Milestones need new derivation (§4.3) and new `milestone_reached` events (§4.8, §9.2 R-3) → FALSE / already built. `milestone-service.ts` (VTID-01250) already detects `profile_complete`, `first_diary`, `first_group`, `first_event_rsvp`, `first_connection`, `first_referral` and more. It emits `user.milestone.reached` and pays VTNA — `services/gateway/src/services/milestone-service.ts:1-14, 40-160, 304-310`
- The greeting ladder is still inline in `orb-live.ts` (R7) → PARTIAL. The decision logic lives in `services/conversation/compute-greeting-decision.ts`; `orb-live.ts` (19,319 lines) also references `first_time_welcome`.

## Findings
F1 [blocker] The live pilot can still put the pilot accounts in front of real members. The allowlist only limits *who the coach acts for*, not *who is on the other end*.
Evidence: §4.5.1 intros ("Anna also loves trail running … say hi for you?") send a DM from a pilot account to a matched real member. §4.5.4 posts a weekly "new faces" thread in Alle Beisammen, a real tenant-wide group. §4.5.2 enriches the real `NewMemberCard`, which veterans see. §6.3 says "nothing fans out to other members", but no mechanism enforces that for counterparties. Jovana, Alex Red and Alex Blue are deliberately left out of `service_bot_accounts`/`notification_test_actors` (§6.3), which rules 43–45 exist to prevent.
Suggestion: In pilot mode, require **both** sides of any send, intro, match candidate, feed card or group post to be in `VOA_PILOT_USER_IDS`. Disable the Alle Beisammen thread and the veteran-card enrichment until the allowlist is lifted. Add simulation scenarios that assert zero rows reach anyone outside the allowlist. Settle whether Alex Red/Alex Blue are real people or test accounts. If they are test accounts, rule 44 applies and an owner decision is needed (see Questions).

F2 [blocker] Several premises the plan builds on are stale, so the sequencing and parts of the scope are wrong.
Evidence: The Audiobook is merged (`b230482`, #1192), yet §9.1 and "Order of execution" treat it as pending. What's New is not empty. §9.2 R-1 ("proposed: inspiration post earns nothing") was already decided by VTID-04864 (`vtna-reward-rules.ts:14-15, 115-117`). §3.3 "Server-side `onboarding_completed_at`" collides with the VTID-04878 owner decision that `onboarding_complete` pays **at signup** because "nothing records the guided onboarding as finished" (`milestone-service.ts:299-310`).
Suggestion: Rewrite §2, §9.1 and §9.2 against main as of 2026-10-05. Rebase C1–C10 on the merged code, for example the real topic ids and the actual reminder gate. State that `onboarding_completed_at` is a coach-only signal and must not change the `onboarding_complete` reward trigger.

F3 [major] The plan would rebuild milestone detection and a parallel event stream that already exist (NEVER rule 5 / ALWAYS rule 9).
Evidence: `milestone-service.ts` already covers profile complete, first diary, first group, first RSVP, first connection and first referral. It emits `user.milestone.reached` and is the VTNA payer. The plan adds `onboarding.coach.milestone_reached` plus its own derivation.
Suggestion: Extend `MILESTONES` and its checkers with the VOA-only items (first ORB conversation, push granted, topics heard, first DM reply received). Have the coach read `user.milestone.reached`. Drop the separate milestone event. That also closes R-3.

F4 [major] Done-by-Vitana actions may trigger VTNA payouts through the existing milestone payer.
Evidence: Vitana-brokered intros and DMs (§4.5.1) and "tell Mariia" messages (§4.5.3) are sent by Vitana on the member's behalf. If an intro produces a connection or match acceptance, `first_connection`/`first_match_accepted` (`vtna-reward-rules.ts:60-68`) would pay, although the owner rule says done-by-Vitana never earns. The auto-Friday posting toggle (§4.6 flow step 2) is fully done-by-Vitana.
Suggestion: Tag every VOA-originated row with `metadata.done_by_vitana=true` (chat messages, connections, posts) and make the milestone checkers ignore tagged rows. Add a simulation scenario that asserts zero VTNA credit from intro, post and Mariia flows.

F5 [major] Staging and production both run against the production Supabase project, so the tick and the flag design can double-send or act from staging.
Evidence: Both repos' CLAUDE.md say staging writes to the production Supabase project. With `staging-only` or `staging+prod`, a staging tick would compute and send for real members, and two schedulers or instances would race. §6.2 calls shadow mode "read-only", but it writes `onboarding_coach_state` and the decision log to production.
Suggestion: Make send idempotency DB-enforced, for example a unique `(user_id, action_key, day)` touch ledger with insert-before-send. Register the EventBridge schedule against the production gateway only, and have staging refuse `live` mode. Correct the shadow-mode wording to "writes only coach-owned tables, sends nothing", and say so explicitly in the VTID.

F6 [major] The Mariia welcome DM path is underspecified, and as written it bypasses the pilot allowlist.
Evidence: §4.5.5 says "DB-trigger/tick path". A trigger on `user_tenants` cannot see the gateway-code allowlist, so it would message every new signup from day one. The pilot accounts are existing members, so a membership trigger never fires for them anyway. §4.7 also adds a signup-time DB trigger on `user_tenants`; that table already carries the welcome and seed triggers, and fix-first #1 rewrites one of them.
Suggestion: Send the Mariia DM only from the gateway tick: allowlist plus cohort check, a `voa_mariia_welcome_sent_at` unique marker, and the strict exclusion set. Kick-off can stay as a cheap trigger that inserts a `onboarding_coach_state` row. Define how pilot accounts are forced into stage `d0` (an override, not real tenure).

F7 [major] Outbound sends would use the fail-open exclusion lookup.
Evidence: `fetchExcludedTestServiceAccountIds` returns an empty set on error (`excluded-test-service-accounts.ts:36-39`). For sends that reach real people, "could not tell" must not mean "not excluded". VTID-04735 added a Strict variant for exactly this reason.
Suggestion: Use `fetchExcludedTestServiceAccountIdsStrict` and skip the whole tick on `ok:false`. Do the same for the pilot allowlist resolution.

F8 [major] The plan does not name the Staging Verification Gate or the existing regression suites it touches.
Evidence: Rules 46–48 require each deploying VTID to carry `docs/validation/<VTID>/staging-tests.json` with read-only staging specs. §6 only covers CI, shadow and pilot. Slice 3 changes greeting ladders and ORB profile surfaces, which is covered by rule 42h `test:roles` (VTID-04560). The coach must also stay community-surface only, since work surfaces never carry member content.
Suggestion: For each slice, list its staging-tests (for example, the Home card renders for a cohort fixture read-only, and the tick endpoint returns 401 without a token). Add `npm run test:roles` to slice 3's done criteria. Gate the rung on the community `AssistantProfile`.

F9 [major] The cadence and budget have no single enforcement point.
Evidence: The pacer's cap depends on presence level; a quiet member has cap 1, which VOA would consume entirely. The Audiobook reminder goes through `reminder_due`, not the pacer (C5). The rewards plan adds its own reminders (R-2). The Mariia DM push, intro-reply pushes and digest are not classified as touches or non-touches.
Suggestion: Add `onboarding_coach` to `ProactiveSurface`. Have the coach check one "onboarding touch ledger" that the reminder and reward senders also write to, or have the coach read `reminder_due` sends for the day. Define in a table which messages count as a touch. Respect presence level by using `min(1, cap-1)` for quiet members, or decide that VOA replaces the other touch.

F10 [minor] The tick route has to adopt VTID-04677 auth, merged today.
Evidence: HEAD `7ad4276c` adds `requireScheduledNotificationsAuth` and makes the Lambdas read `vitana/gateway/prod/internal-token`.
Suggestion: Mount the tick behind that middleware and have the EventBridge script read the secret, matching `setup-eventbridge-daily-feature-tip.sh`.

F11 [minor] `post_kind` and the trigger-skip migration belong to the vitana-v1 `supabase/migrations`, which the plan's scope leaves out. RLS also lets any member set `post_kind` and the "created with Vitana" label.
Evidence: `profile_posts` and `trg_notify_community_post` are defined in vitana-v1 migrations; the INSERT and UPDATE RLS policies are owner-only with no column restriction.
Suggestion: Put the migration in vitana-v1. Have only the gateway (service role) set `post_kind='inspiration'`, with a CHECK or trigger rejecting it from `authenticated`. Note that an `is_public` false→true UPDATE never notifies, which matters for the "go public" step.

F12 [minor] Quote-library legal and scope risk. Modern translations of public-domain authors (Seneca, Laozi) are often under copyright themselves. 150 entries × 11 locales is roughly 1,650 texts for the owner to approve by hand.
Suggestion: Store the translation source and licence per locale. Seed a smaller first library (≥ the 90-day need of about 13 weekly posts per member) and allow fewer locales at first, with a fallback to "no offer" rather than an untranslated quote.

F13 [minor] The intro channel reuses the queue the plan itself says isn't landing.
Evidence: §2 says Community Autopilot is 93% rejected or expired, while §9.3 routes VOA proposals through `proposeToMember`.
Suggestion: Keep `proposeToMember` for storage, but surface intros through the VOA card or ORB rung, and measure acceptance separately.

F14 [minor] The Home card placement is wrong. The `cardSlots` index n renders after feed item n, so "top, above Vitana Index" needs a different insertion point. C4 now applies to the merged `LongevityJourneyCard`.
Suggestion: Specify the actual insertion point, and make the card slot conditional (cohort only) so established members' feeds are unchanged.

## Questions for the planner
1. Are Alex Red and Alex Blue real people or test accounts? If test accounts, rule 44 requires registering them in both allowlists, and §6.3 says they must not be. That is an owner decision on how to reconcile rule 44 with decision 8, not something the plan can settle.
2. In pilot mode, who are the intro candidates, the Alle Beisammen audience and the veteran-card viewers? Only the four allowlisted accounts, or real members?
3. Does the live pilot run from the production gateway or the staging gateway? Both write to the same production Supabase.
4. How are existing-member pilot accounts placed in stage `d0`? Through an override row, and is it cleaned up afterwards?
5. Is "post for me automatically on Fridays" an owner decision? It is not in §8, and it removes per-post consent.
6. Which repo owns the `onboarding_coach_state` migration, and who writes the `profile_posts.post_kind` migration?

## Verdict
NOT CONVERGED. Blockers F1–F2 and majors F3–F9 are open. Owner input is needed on question 1: whether Alex Red and Alex Blue are test accounts and how rule 44 applies to them.


### Planner responses — round 1

- **F1 [blocker] ACCEPTED.** §4.2: the pilot is closed on both sides (every counterparty must be in `VOA_PILOT_USER_IDS`); the Alle Beisammen thread and the new-member-card enrichment are off during the pilot; intros only between pilot accounts. §6.1 adds the "non-allowlisted counterparty receives nothing" scenario; slice 4 makes it a done criterion. The real-or-test question for Jovana/Alex Red/Alex Blue is an owner decision → §8 O1.
- **F2 [blocker] ACCEPTED.** §0, §2, §9 rewritten against main 2026-10-05: Audiobook merged (b230482 / b1116c0b), What's New not empty, R-1 decided by VTID-04864, §3.3 is now a coach-only marker that does not touch the `onboarding_complete` trigger (VTID-04878). C1–C10 restated for the merged code.
- **F3 [major] ACCEPTED.** §4.3: milestones extend `milestone-service.ts` (new ones at reward 0 unless the owner adds them to the rule table); the coach reads `user.milestone.reached`; the separate `milestone_reached` event is dropped (§4.8, §9.2).
- **F4 [major] ACCEPTED.** §4.3: `metadata.done_by_vitana=true` on every VOA-caused row (DMs, intro DMs, Mariia messages, posts, connections from accepted intros); paid milestone checkers ignore tagged rows. §6.1 scenario + slice-4 done criterion: zero VTNA from VOA flows.
- **F5 [major] ACCEPTED.** §4.7 `onboarding_touch_ledger` with `unique(user_id, day)`, inserted before the send; §4.2 live only from the production gateway, staging refuses `live`; EventBridge targets production only; §6.2 states shadow mode writes coach-owned tables only and sends nothing.
- **F6 [major] ACCEPTED.** §4.5.5: Mariia DM only from the gateway tick (allowlist + cohort + strict exclusion + unique marker in the ledger transaction); no `user_tenants` trigger at all (§4.7); pilot accounts enter via `pilot_stage_override` (§4.2, §4.3).
- **F7 [major] ACCEPTED.** §4.2: `fetchExcludedTestServiceAccountIdsStrict`; a failed exclusion or allowlist lookup skips the whole tick; §6.1 scenario.
- **F8 [major] ACCEPTED.** §5: every deploying slice carries read-only `staging-tests.json`, with a concrete spec named per slice; slice 3 requires `test:roles`; §4.2 the coach runs on the community profile only.
- **F9 [major] ACCEPTED.** §4.7: `onboarding_coach` added to `ProactiveSurface`; one DB-enforced touch ledger shared with the Audiobook reminder (the coach reads `reminder_due` sends) and the rewards reminders; a list of what counts as a touch; a quiet member's one pacer touch is VOA's touch that day.
- **F10 [minor] ACCEPTED.** §4.7: tick behind `requireScheduledNotificationsAuth`; the script reads `vitana/gateway/prod/internal-token`.
- **F11 [minor] ACCEPTED.** §4.6: `post_kind` migration in vitana-v1; only the service role may set `inspiration` (a trigger rejects `authenticated`); noted that an `is_public` false→true UPDATE never fires the INSERT trigger.
- **F12 [minor] ACCEPTED.** §4.6: per-locale translation source and licence; first seed ~30 entries in de + en; no offer when the member's locale has no approved entry.
- **F13 [minor] ACCEPTED.** §4.5.1: `proposeToMember` for storage only; intros surface through the VOA card and ORB rung; acceptance measured separately.
- **F14 [minor] ACCEPTED.** §4.7: the card is inserted before the first feed item and only for cohort members; it points at `LongevityJourneyCard` for "listen".

Answers to the partner's questions:
1. Owner decision → §8 O1.
2. Pilot mode: only the four allowlisted accounts, on every side (§4.2).
3. Production gateway only (§4.2, §4.7).
4. `pilot_stage_override` on the coach state row, removed when the pilot ends (§4.2).
5. Not an owner decision → removed from v2, asked as §8 O2.
6. `onboarding_coach_state` and `onboarding_touch_ledger`: platform `supabase/migrations`; `profile_posts.post_kind`: vitana-v1 `supabase/migrations` (§4.3, §4.6).


---

## Round 2 — partner findings (verbatim)

## Verified premises
- `milestone-service.ts` can take milestones with reward 0 → TRUE. `awardMilestone` records the milestone and emits the event, then returns before calling `credit_wallet` when `def.reward <= 0` — `services/gateway/src/services/milestone-service.ts:462-481`
- The milestone checkers can ignore rows tagged `metadata.done_by_vitana` → PARTIAL/FALSE as written:
  - The paid checkers count `relationship_edges`, `memory_items`, `global_event_participants`, `matches_daily`, `referrals`, `user_topic_profile` and `vitana_index_scores` — `milestone-service-repository.ts:41-110`.
  - None of them count `chat_messages` or `profile_posts`.
  - `relationship_edges` is declared five times, each with `CREATE TABLE IF NOT EXISTS` and different columns (`20251231000001_vtid_01087…sql:54-74` has `context` and no `metadata`; `…01088…sql:161-181` has `metadata`). Which shape is live is unknown.
  - `profile_posts` has no `metadata` column (`vitana-v1/…20260210135042…sql:3-14`).
- `ProactiveSurface` can take a new member → PARTIAL. The TypeScript union is easy to extend (`presence-pacer.ts:27-45`). But `user_proactive_touches.surface` has a DB CHECK that lists only 7 values (`20260419130000_user_proactive_touches.sql:17-26`), no repo migration widens it, and a failed `recordTouch` only logs a warning (`presence-pacer.ts:197-199`).
- `reminder_due` sends can be read per member and day → PARTIAL. Only the Audiobook reminder leaves a per-day stamp: `user_guided_journey_state.metadata.audiobook_reminder.last_sent_local_date`, in the member's local date (`20261001130000_VTID_04763…sql:65-72`). It is stamped when the reminder is claimed, even if the push is then not delivered (`audiobook-reminder-dispatch.ts:53-68`). Generic `reminder_due` sends have no such record.
- The Audiobook is merged in both repos → TRUE. Platform `b1116c0b` (#3836), app `b230482` (#1192).
- The tick route sits behind `requireScheduledNotificationsAuth` → TRUE, but both environments run it in `log` mode, which lets calls without a token through:
  - `AWS-STAGE-DEPLOY-GATEWAY.yml:800-806`: staging strips the variable, so the code default `log` applies.
  - `AWS-PROD-DEPLOY-GATEWAY.yml:936-937`: production deliberately stays in `log`.
  - `middleware/scheduled-notifications-auth.ts:44-51`: anything other than `enforce` or `off` resolves to `log`.
- The pacer's day is the UTC day → TRUE — `presence-pacer.ts:118-121`

## Round-1 findings status
- F1 **closed.** The pilot is closed on both sides, and the Alle Beisammen thread and the card enrichment are off during the pilot. O1 is correctly left to the owner.
- F2 **closed.** §0, §2 and §9 match main; I checked `b1116c0b`, `b230482` and the What's New entries. §3.3 no longer touches the `onboarding_complete` trigger.
- F3 **closed.** Milestones extend `milestone-service`, and reward-0 milestones are supported (see above).
- F4 **acknowledged.** The intent is right, but the tagging mechanism doesn't match the schemas (see N2).
- F5 **acknowledged.** The ledger and "live only on prod" fix the double-send. The staging tick is still reachable without a token, and a shadow run there writes to the production database (see N1).
- F6 **closed** for the trigger path. The new marker/ledger coupling contradicts itself (see N3).
- F7 **closed.**
- F8 **acknowledged.** The slice-1 staging spec cannot pass and is not read-only (see N1). Slices 2 and 3 are fine.
- F9 **acknowledged.** Two parts of the design rest on premises that don't hold (see N4 and N5).
- F10 **acknowledged.** The middleware is in place, but it does not enforce in either environment (see N1).
- F11 **closed.**
- F12 **closed.**
- F13 **closed.**
- F14 **closed.**

## Findings
N1 [blocker] The slice-1 staging test ("tick returns 401 without the internal token") cannot pass, and running it would write to production.
Evidence:
- Staging and production both run `SCHEDULED_NOTIFICATIONS_AUTH_MODE` in `log` (`AWS-STAGE-DEPLOY-GATEWAY.yml:800-806`, `AWS-PROD-DEPLOY-GATEWAY.yml:936-937`). A POST without a token is logged and **executed**.
- On staging that runs the coach tick. "Staging refuses `live`" still leaves shadow mode, which writes `onboarding_coach_state` and the decision log to the production database. The test is also a non-GET to the gateway, which the staging network guard aborts (v1 CLAUDE.md gate rule 3, platform rule 48).
- In production, anyone on the internet can call the tick, so its timing is not under our control.
Suggestion:
- Make the tick route enforce the token itself, whatever the global mode: 401 without a token, 503 if `GATEWAY_INTERNAL_TOKEN` is unset. Prove that in Jest.
- Have the staging gateway refuse the tick outright (no shadow, no live).
- Replace the staging spec with a read-only GET, for example a coach status/health endpoint reporting `mode: disabled-on-staging`. Never a POST.

N2 [major] The `metadata.done_by_vitana` tag assumes columns that don't exist (or aren't confirmed) on the tables the paid checkers count. It is also mostly unnecessary.
Evidence:
- `profile_posts` has no `metadata` column.
- `relationship_edges` has five conflicting `IF NOT EXISTS` definitions, so its live columns are unknown.
- No paid checker counts `chat_messages` or `profile_posts`, so VOA DMs and posts can't trigger a paid milestone anyway. The only real exposure is the line in §4.3 about "connections created through an accepted intro".
Suggestion:
- State the rule as "VOA never writes rows to any table a paid checker counts": no `relationship_edges`, group membership, RSVPs or matches created by the coach. Any connection is made by the member's own action afterwards.
- Tag only `chat_messages.metadata` and `profile_posts.post_kind`.
- Keep the simulation assertion of zero VTNA. If the owner does want to exclude intro-originated connections, read the live `relationship_edges` schema first and name the exact column.

N3 [major] The touch-ledger design contradicts itself and leaves failure handling undefined.
Evidence:
- §4.5.5 sets the Mariia marker "in the same transaction as the touch-ledger row", but §4.7 says the Mariia DM is **not** a touch. With `unique(user_id, day)`, writing a ledger row for it would use up day 0's only slot.
- supabase-js has no multi-statement transactions, so this needs a SECURITY DEFINER RPC.
- "day" is undefined: the pacer uses the UTC day (`presence-pacer.ts:118-121`), the Audiobook reminder uses the member's local date, and §4.6 says "Friday afternoon local time".
- Insert-before-send with no status means a failed send uses up the day's slot. For the Mariia marker it loses the welcome DM permanently.
Suggestion:
- Keep the Mariia DM out of the ledger, with its own unique marker.
- Define `day` as the member's local date and use it everywhere.
- Add `status pending|sent|failed`, with one bounded retry for `failed`.
- Do the claim through one RPC, the same pattern as `claim_due_audiobook_reminders`.

N4 [major] Adding `onboarding_coach` to `ProactiveSurface` alone will let the pacer silently stop counting VOA touches.
Evidence: The DB CHECK lists 7 surfaces (`20260419130000…sql:17-26`). No repo migration widens it, although the TypeScript union already has 11 members (live data apparently already holds `did_you_know_card`/`voice_opener_initiative`, judging from `20260427170000…sql:10-13`, so the live schema may have drifted). `recordTouch` only warns on error (`presence-pacer.ts:197-199`). The result would be that VOA's touch never counts toward the cross-surface cap.
Suggestion: Read the live constraint and add a migration that widens it to the full union plus `onboarding_coach`. Treat a failed `recordTouch` as a failed touch: mark the ledger row failed and send nothing.

N5 [major] Sharing the budget with the Audiobook reminder by reading its stamp is racy.
Evidence:
- The reminder fires at a local time the member picks, through its own claim RPC, and is stamped only when claimed (`20261001130000…sql:65-72`). A VOA touch at 10:00 plus a reminder at 19:00 gives two touches.
- The stamp is set even when the push is not delivered.
- Generic `reminder_due` sends have no per-day record.
- "Rewards reminders write to the same ledger" depends on a session that has no code yet.
Suggestion: If the Audiobook reminder is enabled and today's episode isn't finished, count that day as the reminder's, and VOA sends no push or in-app nudge. Alternatively, have `claim_due_audiobook_reminders` check and write the shared ledger, as a change inside a VOA slice. Record the rewards-ledger write as a dependency for that plan.

N6 [minor] `.touch_skipped{reason}` emitted for each cohort member on every tick amounts to heartbeat-like OASIS events (NEVER rule 10).
Suggestion: Log one aggregate event per tick and keep the per-member reasons in the decision log.

N7 [minor] Reading `user.milestone.reached` from `oasis_events` for each member is the wrong store to read from. Separately, each reward-0 milestone adds a completed `autopilot_recommendations` row (`milestone-service.ts:204-232`).
Suggestion: Read the milestone rows (`source_type='milestone'`) instead of the events. Confirm that member-facing Autopilot lists filter out `source_type='milestone'`.

## Questions for the planner
1. Which `relationship_edges` shape is live, and does any VOA flow create an edge itself, or only the member afterwards?
2. Is "day" the member's local date? How does that line up with the pacer's UTC day?
3. Is changing `claim_due_audiobook_reminders` in scope for a VOA slice, or will VOA simply give way on days the reminder is enabled?
4. Will the tick route enforce its token itself, or wait for the owner-approved global `enforce` flip?

## Verdict
NOT CONVERGED. Blocker N1 and majors N2–N5 are open, all introduced or exposed by v2. O1 and O2 remain owner questions, not plan defects.


### Planner responses — round 2

Owner decisions received between rounds (recorded in §8 as 13 and 14, not for re-argument): **O1** Jovana, Alex Red, Alex Blue are real members and are used as pilot accounts; **O2** the automatic Friday-post switch is wanted (§4.6 now specifies it).

- **N1 [blocker] ACCEPTED.** Verified: `SCHEDULED_NOTIFICATIONS_AUTH_MODE` is stripped on staging and unset on prod → `log`. §4.2: the coach-tick handler enforces `X-Gateway-Internal` itself (401 / 503), proven in Jest; the staging gateway refuses the tick entirely (no shadow either). §5 slice 1: the staging spec is now a read-only `GET /api/v1/onboarding-coach/status` reporting `mode: disabled-on-staging`; never a POST.
- **N2 [major] ACCEPTED.** §4.3 restated: VOA never writes to any table a paid checker counts; connections/joins/RSVPs are the member's own later actions; VOA writes only `chat_messages` (tagged in `metadata`) and `profile_posts` (`post_kind`). No `relationship_edges` writes, so its live shape does not matter to VOA. Simulation keeps the zero-VTNA assertion.
- **N3 [major] ACCEPTED.** §4.5.5: the Mariia DM is out of the touch ledger with its own `claim_mariia_welcome` RPC and `pending|sent|failed` + one retry. §4.7: `local_day` = member's local date everywhere; ledger `status` + one same-day retry; claims via a SECURITY DEFINER RPC (`claim_onboarding_touch`), same pattern as `claim_due_audiobook_reminders`.
- **N4 [major] ACCEPTED.** §4.7: slice 1 adds a migration that reads the live CHECK and widens it to the full union + `onboarding_coach`; a failed `recordTouch` marks the ledger row `failed` and nothing is sent.
- **N5 [major] ACCEPTED** (first option). §4.7: on a day with the Audiobook reminder enabled and today's episode unfinished, VOA sends no push/in-app nudge; `claim_due_audiobook_reminders` is not changed. Rewards reminders: recorded as a dependency for the rewards plan (that plan has no reminder code today).
- **N6 [minor] ACCEPTED.** §4.8: one aggregate `onboarding.coach.tick_completed` per tick; per-member skip reasons only in the coach's decision log.
- **N7 [minor] ACCEPTED.** §4.3: the coach reads milestone rows (`source_type='milestone'`), not `oasis_events`; slice 1 confirms member-facing Autopilot lists filter those rows.

Round-1 items marked acknowledged (F4, F5, F8, F9, F10) are addressed by N2, N1, N1, N4/N5 and N1 respectively.

Answers to the partner's questions:
1. VOA creates no `relationship_edges` rows; only the member does, afterwards (§4.3).
2. Yes — the member's local date; the pacer keeps its UTC day and VOA must pass both (§4.7).
3. VOA gives way; `claim_due_audiobook_reminders` is unchanged (§4.7).
4. The tick route enforces its token itself now, independent of the global flip (§4.2).


---

## Round 3 — partner findings (verbatim)

## Verified premises
- Since VTID-04677, both environments run `SCHEDULED_NOTIFICATIONS_AUTH_MODE` in `log`, which lets calls without a token through. A check inside the tick handler is therefore the only real gate → TRUE — `AWS-STAGE-DEPLOY-GATEWAY.yml:800-806`, `AWS-PROD-DEPLOY-GATEWAY.yml:936-937`, `middleware/scheduled-notifications-auth.ts:44-51`
- The gateway can tell it is running on staging, so it can refuse the tick there → TRUE — `services/feature-flags.ts:19,84` (`isStaging` from `../env`)
- The "same pattern as `claim_due_audiobook_reminders`" includes locking the RPCs down: `REVOKE ALL … FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE … TO service_role` → TRUE — `20261001130000_VTID_04763_audiobook_daily_reminder_claim.sql:87-88`
- `awardMilestone` skips `credit_wallet` at reward 0 → TRUE — `milestone-service.ts:476-481`
- The paid milestone checkers count none of `chat_messages` and `profile_posts`, so "VOA writes only those two" gives zero VTNA by construction → TRUE — `milestone-service-repository.ts:41-110`
- Milestones are recorded as `autopilot_recommendations` rows with `source_type='milestone'`, so the coach can read those rows → TRUE — `milestone-service.ts:204-232`
- The `user_proactive_touches.surface` CHECK in the repo lists 7 values and no migration widens it → TRUE. The plan now adds that migration — `20260419130000_user_proactive_touches.sql:17-26`
- The Audiobook reminder is sent only on days the member hasn't listened yet, and it stamps the member's local date → TRUE — `audiobook-reminder-dispatch.ts:1-20`, `20261001130000…sql:65-72`

## Prior findings status
- F4 **closed** via N2. Zero VTNA now holds by construction: VOA writes no table any paid checker counts (§4.3).
- F5 **closed** via N1. The ledger is DB-enforced, the coach runs only on the production gateway, staging refuses the tick, and shadow-mode writes are stated openly.
- F8 **closed** via N1. The slice-1 staging spec is now a read-only GET; slice 3 requires `test:roles`.
- F9 **closed** via N4/N5. The CHECK migration is in the plan, a failed `recordTouch` fails the touch, and VOA gives way to the Audiobook reminder.
- F10 **closed**. The tick handler enforces the token itself (401/503), with Jest tests.
- N1 **closed**. Own token check, tick refused on staging, staging spec is a `GET …/onboarding-coach/status`.
- N2 **closed**. Verified against the checker queries above.
- N3 **closed**. The Mariia DM has its own claim RPC with `pending|sent|failed` and one retry; the ledger uses `local_day` and a status; claims go through a SECURITY DEFINER RPC.
- N4 **closed**. One detail is left as minor M1.
- N5 **closed** (the "give way" option). One edge case is left as minor M2.
- N6 **closed**. One aggregate event per tick.
- N7 **closed**. The coach reads milestone rows, and slice 1 confirms the Autopilot list filtering.

## Findings
No new blocker or major findings in v3. Implementation-level minors:

M1 [minor] The CHECK migration has to be written so it cannot fail against live data. If the live table holds surfaces outside the TypeScript union, `ADD CONSTRAINT` validates existing rows and the migration aborts.
Evidence: The repo constraint (7 values) has drifted from what the code writes, and live rows from `did_you_know_card`/`voice_opener_initiative` are evident (`20260427170000…sql:10-13`).
Suggestion: Before writing the migration, query `SELECT DISTINCT surface` (read-only). Build the list from both the TypeScript union and that query. Use `ADD CONSTRAINT … NOT VALID`, then `VALIDATE`.

M2 [minor] Giving way to the Audiobook reminder can still allow two touches in one day. If the reminder fires at 19:00 and the member finishes the episode at 19:30, a later tick sees "episode finished" and sends a VOA touch as well.
Suggestion: Also give way when `metadata.audiobook_reminder.last_sent_local_date = today`.

M3 [minor] The automatic Friday posts (O2) need a few edges spelled out. This is about how §4.6 implements O2, not about the decision itself.
- **Report-back counts as a second touch:** "Vitana tells the member afterwards what it posted" would be a second Friday touch, and the unique ledger would block it. Make the report a Home card or an ORB mention (not a touch), or the next day's touch.
- **Posting for inactive members:** state that automatic posts stop when the member is inactive (for example no app open in 7 days), says "stop", opts out, or leaves the 90-day window. Also say whether the switch outlives VOA.
- **Re-asking after deletions:** "asks again later" after 2 deletions needs a floor, for example not before 30 days, and only once.

M4 [minor] `voa_mariia_welcome_sent_at` on `onboarding_coach_state` duplicates the new `claim_mariia_welcome` status.
Suggestion: Keep one source of truth, the claim row.

## Questions for the planner
None blocking.

## Verdict
CONVERGED. No blocker or major finding is open or disputed after three rounds. M1–M4 are implementation details for the slice VTIDs. Owner decisions 13 (O1) and 14 (O2) are recorded in §8 and were not re-argued.


### Planner responses — round 3

Verdict CONVERGED; no blocker/major open or disputed. The four minors are applied to the final plan as suggested:
- **M1 ACCEPTED** — §4.7: CHECK list from the union + a read-only `SELECT DISTINCT surface`, `NOT VALID` then `VALIDATE`.
- **M2 ACCEPTED** — §4.7: VOA also gives way when the reminder was already sent today.
- **M3 ACCEPTED** — §4.6: the automatic post is the day's touch; the report-back is a Home card / ORB mention; pauses after 7 inactive days, stop, opt-out or day 90; re-ask once, not before 30 days.
- **M4 ACCEPTED** — §4.3: `voa_mariia_welcome_sent_at` removed; the claim row is the single source of truth.


---

## Confirmation pass on the final text — partner (verbatim)

## M1–M4 status
- **M1: closed.** The CHECK migration list is built from the TypeScript union plus a read-only `SELECT DISTINCT surface`, added `NOT VALID` and then validated (plan §4.7, line 171).
- **M2: closed.** VOA now also gives way when `metadata.audiobook_reminder.last_sent_local_date = today` (§4.7, line 172).
- **M3: closed.** All parts are in §4.6 (lines 153–157):
  - The automatic Friday post is that day's touch.
  - The report-back goes on the Home card and in the next ORB conversation, and is not a second touch.
  - Posting pauses after 7 days without opening the app, on "stop", on opt-out, or when the member leaves the 90-day window.
  - Vitana asks again once, not before 30 days.
- **M4: closed.** `voa_mariia_welcome_sent_at` is gone from the `onboarding_coach_state` columns. §4.3 (line 93) points to the claim row in §4.5.5 as the only record, and §4.5.5 (line 129) agrees.

## New findings
None at blocker or major level. I checked §4.5.5, the touch list in §4.7, §8 item 14, the §5 done criteria and C5 in §9.1. They are consistent with the edits. Three small loose ends can be settled in the slice VTIDs:
- **Friday post versus the reminder's day.** On a Friday when the Audiobook reminder owns the day, the "give way" rule (line 172) only stops push and in-app nudges. It doesn't say whether the automatic post, which counts as a touch (line 154), is held back too. Suggest it skips that Friday.
- **Who runs the switch after day 90.** "The switch ends with VOA unless the member keeps it" (line 156) leaves open which system runs a kept switch, and under which guardrails. Suggest stating that normal Autopilot inherits it with the same guardrails.
- **Slice 5 tests.** The slice 5 done criteria (line 197) don't include scenarios for the automatic Friday post: the pause rules, delete-as-ignore, and auto-off after 2 deletions. Suggest adding them to the simulation.

## Verdict
CONFIRMED-CONVERGED
