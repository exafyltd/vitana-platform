# VTID-04883 — Plan Sparring record

- Change class: standard. Tier: session (plan-sparring skill, partner agent `plan-sparring-partner`, read-only).
- Rounds: 2. Verdict: **CONVERGED** (round 1: 8 findings and 4 questions — F1–F8 answered: 7 accepted, F3 rejected
  with a measured reason the partner accepted in round 2; round 2: all closed, no new findings).
- Final plan hash (canonical): `a5cfef7839d4927bbf80b72ec6d7770a4cc6157e84e9ae2ab30788e187a4f468`
- Owner approval 2026-10-05 (chat): "1. move to bedrock (D4, separate fix — VTID-04889) 2. you decide (All News out of
  scope) 3. you decide (D6/D7 sampling 10%) 4. approved (the rule-45 fix merges first — VTID-04888, merged 2026-10-07)".
- VTID allocated after approval with `p_plan_hash`; the gate was in `log` mode; sparring recorded in
  `vtid_ledger.metadata.sparring`.

## Round 1 (summary of the partner's findings and the planner's answers)
- F1 D6 must not sit on the notification critical path → ACCEPTED: after the insert and push, sampled by notification id.
- F2 composer line numbers → ACCEPTED (composer.ts:201-242).
- F3 the new pins would push the task-definition run step over GitHub's 20,000-char limit → REJECTED: the Jev pins
  live in their own step ("Resolve Jev decision config", 3,408 chars measured); a test asserts it stays under 20,000.
- F4 D3 is a re-rank check of the SQL #1 and must skip the exact-name short-circuit → ACCEPTED.
- F5 quantify volume → ACCEPTED (D1 ≈72/day now, ≈16 after the leader-lock fix; D2 ≈38; D6 ≈52 at 10%).
- F6 D8 fires on the `pickByQueryHash` fallback only → ACCEPTED.
- F7 → no action.
- F8 the rule-45 breach must be fixed first → ACCEPTED (owner decision 4; VTID-04888).
- Q1 enforce is a later per-gate plan; Q2 D6 subject = notification id; Q3 D2 is fire-and-forget after `rank()`;
  Q4 every gate returns before any network call unless JEV_COMMUNITY_ENABLED and a shadow mode are set.

## Round 2
All findings closed; CONVERGED.

## Built vs plan (one deviation, stated)
The plan said "the PR adds a support-suite check that notifyUser's result is unchanged with the gate on". The support
suite never calls `notifyUser`, so that check lives in `test/vtid-04883-community-ranking.test.ts` instead: the D6 call
is pinned as `void … .catch(() => undefined);` immediately before `notifyUser`'s unchanged `return`, after the push.
The support suite is still run and green.

---

# Plan — Jev member ranking gates D1–D8, shadow on staging only

Owner instruction 2026-10-04: "build 1–3 next, each as its own PR, in shadow on staging only". Item 3 =
docs/JEV-INTEGRATION-PLAN.md §10.4 D (member ranking): D1 calendar priority · D2 next-action choice · D3 Find-a-Match
re-rank · D4 events/groups relevance · D5 Community Autopilot suggestion scoring · D6 notification worth-it/fatigue ·
D7 Discover feed weight · D8 guide/directory tie-breaks. Approved cost control: Class B, shadow first, 300/member/day,
safety exempt. Owner option (b): the member plane stays closed on staging until the TypeSafe DPA, so this PR is inert
after merge, like VTID-04879.

<!-- plan:begin -->
## Change class
standard (new decisions + gates, call sites in live ranking paths, staging workflow pins; no migration, no route).

## Code map (research, file:line)
| # | Today | Live? | Shadow point | Jev calls |
|---|---|---|---|---|
| D1 | calendar-prioritizer.ts:97-131 rule score (base, urgency, pillar boost VTID-04826), PATCH priority_score; 6-hourly loop (calendar-rescheduler.ts:219), ~18 runs/day × ~4 users | yes (staging flag) | after scoring a user's events (:131) | 1 per user run |
| D2 | assistant-continuation next-action composer.ts:201-242 `rank()` by source priority, threshold 50; ~38 composes/day | yes | after `rank()` (composer.ts:106), with the slate | 1 per compose |
| D3 | search_intent_catalog_v2 weighted SQL score, top 5 (intent-find-match.ts:247-256) | code live, ~0 traffic | after `searchIntentCatalog` returns (:256); skipped when the exact-name short-circuit (:259+) picks the result | 1 per request |
| D4 | vitana-v1 edge function generate-enhanced-recommendations on **Gemini** (forbidden Google), manual button only, tables 0 rows ever | dead | **none — out of scope** (retire/replace separately) | — |
| D5 | live producer: index-pillar-weighter.ts `rankBatch` (:473) over template recs; CA-5 scan writes nothing | yes, few users/day | after `rankBatch` | 1 per batch |
| D6 | notification-service.ts:653 `notifyUser`: switches, DND, TYPE_META; no fatigue rule; ~523/day, bursty fan-outs | yes | **after the insert and push** (off the critical path), **sampled** by the inserted notification id | ≤1 per sampled notification |
| D7 | discover-feed.ts:95 → feed-ranker.ts:110-206 product feed; All News is ranked client-side in vitana-v1 | yes (no telemetry) | product feed route after `rankFeedProducts`, **sampled**; All News out of scope (client) | ≤1 per sampled request |
| D8 | community-member-ranker.ts tiers + insertion-order ties (:532), query-hash fallback `pickByQueryHash` (:916) when no tier found a signal-based winner; ~0 searches/30 d | code live, ~0 traffic | on the fallback path only (no signal winner → hash pick from the pool) | 1 per fallback search |

## Design
1. **One-call ranking.** Jev questions are fixed per decision (jev-decision-service.ts:206), so each ranking decision
   is a `choice` over fixed slot labels `c1`…`c8` ("which listed candidate is best for this member now?") with the
   candidates listed in the state in the existing order (max 8; more are cut, recorded as `truncated`). Agreement =
   Jev's pick equals the existing top-1. One call per request, never per candidate. This is a second opinion on an
   already-ranked list (a re-rank check), not an audit of the scoring formula; for D3 the comparison is with the SQL
   #1, and the gate is skipped when the exact-name short-circuit chose the result.
2. **Seven decisions** (D1 `community_calendar_priority`, D2 `community_next_action`, D3 `community_match_rerank`,
   D5 `community_suggestion_pick`, D7 `community_feed_pick`, D8 `community_member_tiebreak` — choice over c1..c8;
   D6 `community_notification_worth` — noul "worth sending to this member now?"). All `data: 'member_content'`,
   `community_class: 'B'` (per-member quota 300/day applies, VTID-04872), `pii: 'redact'`, planes
   internal + system_autopilot, not safety.
3. **State is minimal and derived in code**: candidate type/category/title-length-cut/age/score fields already on the
   candidate; member context only as enums (weakest pillar name, lifecycle stage). No health values (§8.3 health rule),
   no other member's personal data beyond what the candidate already shows (D3/D8 candidates: display name is not
   sent — only kind, fit components, distance band).
4. **Gate module** `jev/gates/community-ranking-gates.ts` reusing the VTID-04879 pattern: fire-and-forget, own
   `.catch` at each call site, skip unless `JEV_COMMUNITY_<GATE>_MODE` shadow + `JEV_COMMUNITY_ENABLED` + tenant +
   member id (quota needs the member); system_autopilot caller with `member_id`; row with hashed subject, no text, Jev
   pick vs existing top-1, `agreed`. Enforce has no path.
5. **Sampling** for D6 and D7: `JEV_COMMUNITY_<GATE>_SAMPLE` (default 0.1 for D6, 0.1 for D7; 0..1), decided by a
   hash of the subject — the inserted notification id for D6, the request id for D7 — so a fan-out is sampled evenly
   and no member is always or never sampled. Rate share (VTID-04874) still applies.
5b. **Volume** (today): D1 ≈ users × runs = ~4 × ~18 ≈ 72 calls/day while the no-leader-lock issue lasts (≈16 once
   fixed); D2 ≈ 38; D6 ≈ 52 (10% of ~523, bursts capped by the rate share); D3/D5/D7/D8 small. Per member that is far
   under the 300/day quota; the quota and rate share bound growth.
6. **Outcome where cheap, later**: D2 records the shown action id; D6 records the notification id; a follow-up can
   join opens/accepts. Not built here.
7. **Pins**: seven `JEV_COMMUNITY_*_MODE=shadow` (+ two sample values) in `AWS-STAGE-DEPLOY-GATEWAY.yml` only; prod
   untouched (test asserts); regenerate flag pins. The Jev pins live in their own step ("Resolve Jev decision
   config", 3,408 chars of run: today), far under GitHub's 20,000-char run limit (VTID-03788); a test asserts the
   step stays under it.
8. **Enforce is not in this PR.** Enforce would mean Jev reorders a member-visible list; that is a separate plan after
   the shadow data, per gate.

## Fix-first findings (not in this PR; own plans/VTIDs)
- **Rule 45 breach**: `search_intent_catalog_v2` / `compute_intent_matches_v2` do not exclude service_bot_accounts /
  notification_test_actors (3 accounts own 18 open intents a member can be shown); vitana-v1 `useCommunityMembers.ts`
  and `useAllNewsFeed.ts` new-member cards also do not exclude them.
- **D4**: two vitana-v1 edge functions call Gemini (forbidden Google); one has no caller and looks broken. Retire or
  move to Bedrock.
- D1 loop runs per task/boot with no leader lock (~18 runs/day instead of 4).

## Tests
- `test/vtid-XXXXX-community-ranking.test.ts`: decisions (slot labels, class B, member content); state builders send
  no names/health values and cut at 8; gates skip on mode/community/tenant/member; sampling is deterministic by
  subject and respects 0/1; agreement on top-1; quota counted (member_id passed); never throws; call sites
  fire-and-forget with catch; existing results unchanged (D1 PATCH values, D2 winner, D3 selected, D5 batch order, D6
  insert, D7 response, D8 pick) with a shadow that hangs or rejects; staging-only pins.
- Suites green: Jev, operator, roles, support (D6 touches `notifyUser`; the gate returns before any call while the
  member plane is closed, and the support suite runs without JEV_COMMUNITY_ENABLED), full suite.
- Staging verify: read-only probes + `existing` suite (gates inert while the member plane is held).

## Owner decisions
1. D4 out of scope here; retire/replace the Gemini functions in a separate fix — confirm.
2. All News (client-side ranking in vitana-v1) out of scope for D7 — confirm.
3. D6/D7 sample rate 10% on staging — confirm or change.
4. **Required sequencing:** the rule-45 fix (own plan) merges before this PR, so no shadow row ranks test/service
   accounts.
<!-- plan:end -->


## Planner responses — round 1
- F1 ACCEPTED — D6 moves after the insert and push; sampled by notification id.
- F2 ACCEPTED — composer.ts:201-242.
- F3 REJECTED — the Jev pins are not in the large task-definition run block: they live in their own step
  "Resolve Jev decision config" (AWS-STAGE-DEPLOY-GATEWAY.yml), whose run: scalar is 3,408 characters today (measured);
  nine more `{name:…, value:…}` entries add ~550. A test will assert that step stays under 20,000.
- F4 ACCEPTED — D3 compares with the SQL #1 and is skipped on the exact-name short-circuit; "re-rank check" stated.
- F5 ACCEPTED — volume quantified (D1 ≈72/day now, ≈16 after the leader-lock fix); within quota.
- F6 ACCEPTED — D8 fires on the `pickByQueryHash` fallback path only; wording fixed.
- F7 — no action.
- F8 ACCEPTED — rule-45 fix is required to merge before this PR (owner decision 4 rewritten as required sequencing).
- Q1 — enforce is a later, per-gate plan after shadow data (design item 8).
- Q2 — D6 subject = the inserted notification id (not the user), so sampling is even across members.
- Q3 — D2's shadow is fire-and-forget after `rank()` returns; the compose result is returned without awaiting it.
- Q4 — the gate returns before any network call unless JEV_COMMUNITY_ENABLED and a shadow mode are set; the support
  suite sets neither; the PR adds a support-suite check that notifyUser's result is unchanged with the gate on.
