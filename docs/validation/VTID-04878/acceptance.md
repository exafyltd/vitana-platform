# VTID-04878 — VTNA earning actually pays

Problem (verified read-only 2026-10-04): 253 VTNA wallets, none with earned VTNA; last wallet transaction 2026-07-20. No milestone was ever recorded: `recordMilestone()` sent `tenant_id` (no such column on `autopilot_recommendations`, so PostgREST rejected the insert) and CHECK-violating values (risk_level 'none', impact 80, effort 0), and nobody read the result. The milestone scanner AP-0509 never runs in production (automation heartbeat off), `first_event_rsvp` read a table that does not exist, and credit results were read for `error` only.

Owner decisions: 2026-10-03 (VTID-04864 rule table) and 2026-10-05 (this VTID): onboarding_complete pays at signup; autopilot_action_done 5 VTNA max 2/day; live_room_15min 20 VTNA max 3/week; index_new_best 50 VTNA max 1/week; silent back-pay of first steps already taken. Plan sparring: docs/validation/VTID-04878/plan-sparring.md (escalated on F9, owner said proceed).

AC-1 A milestone is recorded with a row the table accepts (no tenant_id; risk_level low; scores 1..10) and a recording failure is logged and counted; payment is still attempted (keyed, at most once).
TEST: services/gateway/test/vtid-04878-reward-earning.test.ts

AC-2 credit_wallet business failures (data.ok=false) are counted as failures, duplicates are neither failures nor new VTNA.
TEST: services/gateway/test/vtid-04878-reward-earning.test.ts

AC-3 onboarding_complete pays 50 VTNA at signup with the same key AP-1301 uses; first_event_rsvp reads global_event_participants (status attending); one scan catches up several tiers.
TEST: services/gateway/test/vtid-04878-reward-earning.test.ts

AC-4 claim_capped_reward pays an occurrence at most once and never past its UTC day/week cap, counting the field credit_wallet writes (metadata.source); test/service accounts are refused; members cannot call it. Applied twice to a local replica of the live wallet tables with the real credit_wallet; mutation-checked (counting another field fails "third claim is capped", dropping the e2e clause fails "e2e refused").
TEST: services/gateway/test/vtid-04878-capped-reward-migration.test.ts
TEST: scripts/ci/test-vtid-04878-capped-rewards.sh

AC-5 Sweep candidates: real members only; a live-room stay qualifies only with 15 full minutes (timestamps; the live duration column rounds) and someone else present; an Index reading qualifies only as the latest reading at least 10 above every earlier one (first reading is the baseline).
TEST: scripts/ci/test-vtid-04878-capped-rewards.sh

AC-6 The reward sweep pays only on production: staging (VITANA_ENV=staging) refuses before any query; the loop starts only inside AWS ECS; REWARD_SWEEP_ENABLED=false switches it off; a query failure is counted and the run finishes; the time budget stops it and says so; the backfill is quiet (no celebration events).
TEST: services/gateway/test/vtid-04878-reward-earning.test.ts

AC-7 POST /api/v1/rewards/sweep needs X-Gateway-Internal or exafy_admin (401 JSON unauthenticated, 403 member) and returns 409 NOT_PRODUCTION on staging; POST /api/v1/autopilot/recommendations/:id/complete pays autopilot_action_done once for a first-time completion, reports the credited amount (response + OASIS event), and a capped, repeated or failing claim pays 0 without failing the completion.
TEST: services/gateway/test/vtid-04878-reward-routes.test.ts

AC-8 The rule table, Wallet overview and earlier contracts: the three capped rules with amounts/caps/windows, the Wallet overview reports each capped rule's window and count and maps `<rule>:<ref>` keys; suites pinning the old contract are updated only where the owner changed it on purpose, each change commented (VTID-04864 rule-table suite; the /complete route suites now expect the capped claim's credit as `reward`).
TEST: services/gateway/test/vtid-04878-reward-earning.test.ts
TEST: services/gateway/test/vtid-04864-vtna-reward-rules.test.ts
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts
TEST: services/gateway/test/routes/autopilot-recommendations-complete.test.ts

ROUTE_MOUNT: services/gateway/src/routes/rewards-sweep.ts, mounted at /api/v1 in services/gateway/src/index.ts (owner 'rewards-sweep'; requireInternalOrAdmin inside the router)
FINAL_URL: POST /api/v1/rewards/sweep
CURL_PROOF: staging check in docs/validation/VTID-04878/staging-tests.json expects 401 application/json for an unauthenticated POST (rejected probe, no write).

OASIS_IMPACT: yes
OASIS_PROOF: every sweep run emits one `rewards.milestone_sweep.completed` (or `.failed`) event with its counters (services/gateway/src/services/rewards/reward-sweep-runner.ts; topics added to src/types/cicd.ts); `autopilot.recommendation.completed` now carries the real credited reward. No per-member or per-tick events.

Rollout after merge + staging verification + owner approval:
1. Apply migration 20261005100000_vtid_04878_claim_capped_reward.sql (RUN-MIGRATION.yml).
2. Publish the gateway.
3. Run the back-pay once: POST /api/v1/rewards/sweep (internal token, quiet by default). The loop pays every 6 hours from then on.
