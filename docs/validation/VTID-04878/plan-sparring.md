# Plan — Rewards Phase 3: make VTNA earning actually pay (VTID-04878)

Note: VTID-04878 was allocated before the Plan Sparring Gate (VTID-04868) reached this
session's checkout. No code has been written. This sparring runs before any code.

<!-- plan:begin -->
## Change class
standard (gateway service + one new internal route + an in-process production loop + tests; no migration, no deploy-workflow change)

## Problem (verified 2026-10-04, read-only)
- 253 CREDITS wallets, 0 with earned_balance > 0; last wallet_transactions row 2026-07-20.
  Members are promised VTNA (Wallet > Rewards, VTID-04864 rule table) but nobody has been paid.
- No milestone has ever been recorded (0 rows with source_type='milestone'). `recordMilestone()`
  sends `tenant_id`, a column `autopilot_recommendations` does not have (live columns verified),
  so PostgREST rejects the whole insert before Postgres sees it; it also sends risk_level 'none',
  impact_score 80, effort_score 0, which the table CHECKs reject (risk_level low..critical,
  scores 1..10). The insert result is never checked.
- The periodic scanner AP-0509 never runs in production (heartbeat loop only on staging, in shadow
  mode, where AP-0509 is SHADOW_UNSAFE). AP-1301/AP-0708, the only payers of onboarding_complete,
  have never run either.
- Inline checks (`checkMilestonesForAction`) only fire on a transition, so first steps done before
  the ledger existed (2026-10-02) are never paid.
- `first_event_rsvp` reads `community_meetup_attendance`, which no migration creates; RSVPs live
  in `global_event_participants` (status 'attending').
- Milestone credit sites read only `error`, not credit_wallet's `data.ok=false`.

## Goal
Every rule VTID-04864 marks live pays exactly once per member, in production, for things the
member really did, including first steps done before 2026-10-02, without turning on the
production automation engine, without notifying anyone about old achievements, and without any
staging process ever writing.

## Owner decisions this plan follows (not re-argued)
- 2026-10-03 (VTID-04864): earn for real things you do yourself, once per milestone, and for
  consistency; Autopilot completion does not pay on its own; never self-reported or Vitana-done.
- user_wallets.CREDITS is the VTNA ledger; earned bucket only; 1 VTNA = EUR 0.01 (VTID-04809).
- Test/service accounts are never treated as members (CLAUDE.md rules 43-45).

## Work
1. Milestone recording fix (milestone-service.ts): drop `tenant_id` from the row; write
   risk_level 'low', impact_score 8, effort_score 1; check the insert error and log it loudly.
   Payment stays keyed by rewardEventId and is attempted even if recording fails, so a member is
   never left unpaid by a bookkeeping row; the sweep counts recording failures.
2. Credit result: both credit sites use `creditWalletSucceeded()`; ok=false is logged and counted.
3. first_event_rsvp reads `global_event_participants` (status 'attending'); RSVP is the approved
   rule as written, attendance is not claimed.
4. Reward sweep, independent of the daily-recompute pipeline (that route is unauthenticated and
   fail-fast per user, so it is not touched):
   - `runRewardSweep(sb, tenantId, {quiet})` in a new services/rewards/reward-sweep.ts: pages
     primary members 100 at a time, excludes service_bot_accounts, notification_test_actors,
     e2e-%@% / %@vitanatest.exafy.io addresses and the system bot (one query), and calls
     `scanUserMilestones(sb, user, tenant, {quiet})` per member with a per-member try/catch and a
     run time budget. Idempotent (rewardEventId keys + achieved set): a partial run is safe to
     repeat.
   - `scanUserMilestones` gets an optional 4th parameter `{ quiet?: boolean }` (default false, so
     every existing caller is unchanged); quiet skips emitMilestoneEvent. `checkMilestonesForAction`
     is unchanged and keeps emitting for live transitions.
   - Runs only when `VITANA_ENV === 'production'`; on any other environment it refuses
     (NOT_PRODUCTION) before reading or writing, so staging (which shares the database) never pays.
   - Trigger A (backfill / on demand): `POST /api/v1/rewards/sweep`, guarded by
     `requireInternalOrAdmin` (routes/automations.ts: X-Gateway-Internal or exafy_admin),
     quiet=true. Run once after deploy for the backfill.
   - Trigger B (ongoing): an in-process loop started in index.ts only on production, every 6 h,
     quiet=false (new achievements celebrate as today). Cross-instance: before running, it reads
     the latest `rewards.milestone_sweep.completed` event and skips if one is younger than 5 h;
     concurrent runs are still payment-safe (credit_wallet row lock + key).
   - One OASIS event per run: `rewards.milestone_sweep.completed` {mode, members_scanned,
     milestones_recorded, record_failures, vtna_credited, credit_failures, excluded}.
5. Backfill size: at most 210 (first steps) + 170 (streaks) = 380 VTNA (EUR 3.80) per member,
   about 227 members, so EUR 860 worst case; the dry estimate is logged before the first run.
6. Tests (gateway Jest): the milestone row has no tenant_id and satisfies the CHECK values;
   ok=false is counted; first_event_rsvp reads global_event_participants; the sweep excludes all
   four test/service classes; quiet emits no milestone event and default does; a second sweep
   pays nothing; NOT_PRODUCTION refuses before any query; the route rejects unauthenticated calls
   (401/403 JSON); the loop does not start off production. Staging (read-only): POST
   /api/v1/rewards/sweep without credentials returns a JSON 401/403.
7. Docs: backend.md rewards note; docs/validation/VTID-04878/ evidence including this sparring.

## Owner decisions needed (raised with the owner, not built here)
- onboarding_complete (50 VTNA, shown live): nothing verifiable marks onboarding complete today
  (user_guided_journey_state: 113 skipped, 51 in_progress, 0 completed; user_journey all 'new').
  Options: pay on guided journey 'completed' (honest, currently nobody), pay at signup (what
  AP-1301 intended), or hide the rule until a signal exists.
- New earning rules for Autopilot completions, meetups/attendance and Vitana Index gains (they
  conflict with or extend 2026-10-03).
- Turning on the production automation engine.

## Out of scope
Rewards shop, VTNA to Premium conversion, reminders, measurement (later phases).

## Scope (files)
- services/gateway/src/services/milestone-service.ts, milestone-service-repository.ts
- services/gateway/src/services/rewards/reward-sweep.ts (new) + repository
- services/gateway/src/routes/rewards-sweep.ts (new, mounted at /api/v1) and index.ts (mount + loop)
- services/gateway/src/types/cicd.ts (event topic)
- services/gateway/test/vtid-04878-*.test.ts
- docs/validation/VTID-04878/**, .claude/rules/backend.md

## Risks
- Mass first payout: bounded (~EUR 860), silent (quiet backfill), idempotent.
- Duplicate milestone rows if two instances sweep simultaneously (no unique index): mitigated by
  the 5 h event check; payment is unaffected.
- Staging: hard production-only gate in code; the route needs internal or admin auth.

## Revision 2 — owner decisions 2026-10-05 (widens the plan; supersedes "Owner decisions needed")
Owner answers: plan approved; onboarding_complete pays at signup; the new earning rules are added
in this phase with these amounts (1 VTNA = EUR 0.01). This amends the 2026-10-03 rule set
explicitly: Autopilot completion pays again, small and capped.

| Rule id | Pays | Cap | Verified by |
|---|---|---|---|
| onboarding_complete (existing, 50) | at signup (primary membership exists) | once | user_tenants.is_primary |
| autopilot_action_done (new) | 5 | 2 per member per UTC day | complete_autopilot_recommendation succeeded (status activated->completed); milestone rows excluded |
| live_room_15min (new) | 20 | 3 per member per ISO week (UTC) | live_room_attendance row with left_at set, duration_minutes >= 15, and at least one other attendee whose interval overlaps it |
| index_new_best (new) | 50 | 1 per member per ISO week | latest vitana_index_scores.score_total >= previous personal best + 10 (first reading is the baseline, pays nothing) |

8. **Capped claims are atomic in SQL** (new migration
   `vtid_04878_claim_capped_reward.sql`), following claim_invite_reward (VTID-04864):
   `claim_capped_reward(p_tenant_id, p_user_id, p_rule, p_ref, p_amount, p_cap, p_window)`,
   SECURITY DEFINER, service_role only. Per (user, rule) advisory lock; if key `<rule>:<ref>`
   was already paid -> duplicate; else counts this member's wallet_transactions with
   metadata.source = p_rule since date_trunc(p_window) (day|week, UTC); at the cap -> CAPPED, no
   write; else calls credit_wallet(..., 'reward', p_rule, '<rule>:<ref>'). Amount and cap come from
   the gateway rule table, never from a client. Test/service accounts (the four classes) return
   NOT_ELIGIBLE inside the function as a second gate. Verified on a local Postgres replica
   (applied twice, assertions + a mutation check), like VTID-04809/04859.
9. **Payers**:
   - autopilot_action_done: after a successful completion in POST
     /api/v1/autopilot/recommendations/:id/complete and in calendar-producers
     completeSourceForCalendarEvent (the two completion paths); ref = recommendation id; failure
     never fails the completion. The response's `reward` field reports the real credited amount.
   - live_room_15min and index_new_best: evaluated by the reward sweep (Work 4) for activity since
     the last 8 days only (no backfill of these rules); ref = attendance id / score date.
   - onboarding_complete: a new checker in milestone-service (primary membership exists), paid
     with rewardEventId('onboarding_complete') — the same key AP-1301 uses, so it can never pay
     twice. Included in the backfill.
10. **Rule table + Wallet > Rewards**: add the three rules to VTNA_REWARD_RULES (live: true, with
    cap {count, days}); extend reward-overview-service's key->rule mapping for `<rule>:<ref>` keys;
    vitana-v1 adds DE/EN labels for the three rule ids (second PR, What's New entry, staging spec
    that reads GET /api/v1/wallet/reward-rules read-only).
11. **Cost ceiling per member from the new rules**: autopilot 300 + live rooms ~260 + Index ~215
    = ~775 VTNA (~EUR 7.75) per month at the caps; today's usage (28 completions/30 days, 0
    live-room joins, Index ~weekly for 30 members) is far below. Backfill bound becomes 430 VTNA
    per member (~EUR 975 for ~227 members), onboarding included.
12. Tests add: claim_capped_reward SQL harness (duplicate, cap per day/week, window rollover,
    NOT_ELIGIBLE, authenticated cannot execute); completion pays 5 and the 3rd completion of a
    day pays 0; a live room alone or under 15 min pays 0; index first reading pays 0 and +9 pays 0.

Scope additions: supabase/migrations/2026100510xxxx_vtid_04878_claim_capped_reward.sql,
supabase/tests/vtid_04878_*.sql, scripts/ci/test-vtid-04878-*.sh,
services/gateway/src/routes/autopilot-recommendations.ts, services/calendar-producers.ts,
services/rewards/vtna-reward-rules.ts, services/rewards/reward-overview-service.ts,
DATABASE_SCHEMA.md (function), BUSINESS-MODEL.md §11 (owner decision 2026-10-05);
vitana-v1: src/i18n/{de,en}/wallet*.json, src/whats-new/entries/, tests/e2e/staging/.
Change class stays standard (now includes one migration).
13. Payment path made explicit (F11): the gateway is the payer, never the RPC. In the
    /complete route: call complete_autopilot_recommendation; only on success (not
    already_completed) call claim_capped_reward; merge its credited amount into the response's
    `reward`. In completeSourceForCalendarEvent: same call after a successful completion; its
    return gains `reward`. A failed claim is logged and never fails the completion.
14. live_room_15min counts full minutes (duration_minutes is a truncated INT; 14:59 does not
    qualify) (F10).
15. The windowed count reads `metadata->>'source'`, which is where credit_wallet stores p_source
    (live function body: metadata jsonb_build_object('source', p_source, ...); wallet_transactions
    has no source column). The SQL harness proves the cap engages through this exact path
    (third claim in a day returns CAPPED) (F9).
<!-- plan:end -->


## Planner responses (round 1)
- F1 major (fail-fast pipeline): ACCEPTED. The sweep no longer uses daily-recompute at all; it is a standalone service with its own triggers and per-member isolation (Work 4).
- F2 major (per-user stage vs tenant sweep): ACCEPTED. It is a separate sweep with its own member enumeration, exclusions, batching and time budget (Work 4).
- F3 major (unauthenticated route / staging writes): ACCEPTED. Verified the route has no auth and EventBridge targets production. The new route uses requireInternalOrAdmin, and the sweep refuses unless VITANA_ENV === 'production' before any query; the loop starts only on production.
- F4 minor (tenant_id): ACCEPTED and promoted. Verified live: the column does not exist, so PostgREST rejects the insert; this is a root cause. The fix drops tenant_id (Work 1).
- F5 minor (onboarding_complete has no checker): ACCEPTED as an owner decision. Verified no completion signal exists; the options are listed under Owner decisions. Not built until decided.
- F6 minor (recording failure vs payment): ACCEPTED as written; recording failures are now counted in the run event.
- Q1: separate sweep (see F2). Q2: the optional 4th parameter is on scanUserMilestones only; checkMilestonesForAction is unchanged. Q3: verified, no auth on daily-recompute; not used.

## Round 2 (partner)
F1–F6 closed. F7 minor (cicd.ts topic) — covered by scope. F8 minor (duplicate milestone rows without a unique index) — acknowledged as acceptable; payment unaffected.

## Verdict
CONVERGED after 2 rounds (standard class, cap 3). Plan hash (sha256 of text between markers): d8eeec1da6bc1ba309b38462726e3b0b65fba845a5040533bfc12d5981cb1aea

## Round 3 (partner) and planner responses
- F9 major (cap counts a field credit_wallet may not write): REJECTED with evidence. Live credit_wallet (VTID-04809) inserts wallet_transactions.metadata = jsonb_build_object('source', p_source, 'description', ..., 'ledger', 'vtna', ...); the live column list of wallet_transactions has no `source` column. Counting metadata->>'source' is the field credit_wallet populates. Added Work 15: the SQL harness proves the cap engages via this path.
- F10 minor (truncated minutes): ACCEPTED, Work 14.
- F11 minor (payer and response wiring): ACCEPTED, Work 13.

## Verdict
ESCALATED — round cap (3) reached with F9 rejected and not yet re-reviewed by the partner. Side by side for the owner:
- Partner: the cap may never engage if the count reads a field credit_wallet does not write.
- Planner: credit_wallet writes p_source into metadata.source (verified on the live function and columns); the harness will fail if the cap does not engage.
Final plan hash (sha256 of text between markers): fecd3e4e44c18d0b1879ece13a1c5622152ab366f4c6551a146b2439db60ee6d

## Owner decision on the escalation
2026-10-05, in chat: "Proceed" — build with the cap proven by the SQL test (F9 evidence accepted). Recorded in vtid_ledger.metadata.plan_sparring.

## Implementation notes (after approval; no scope change)
- F10 premise corrected by the SQL harness: `live_room_attendance.duration_minutes` stores a numeric expression in an integer column, so Postgres ROUNDS (14:30 reads as 15), it does not truncate. To keep Work 14 ("15 full minutes"), the candidate query compares `left_at - joined_at >= interval '15 minutes'`; the harness pins both facts.
- Work 9's sweep evaluation is implemented as read-only SQL functions in the same migration (`reward_sweep_members`, `reward_sweep_live_room_candidates`, `reward_sweep_index_candidates`, `reward_sweep_is_excluded`) so the test/service-account exclusion lives once, next to `claim_capped_reward`. Lookback is the current ISO week minus 7 h, so an occurrence from a previous week cannot be paid against a new week's cap.
- The in-process loop additionally requires AWS ECS (`ECS_CONTAINER_METADATA_URI_V4`) so a developer's local gateway never pays; `REWARD_SWEEP_ENABLED=false` switches it off.
