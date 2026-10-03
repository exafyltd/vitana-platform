# VTID-04864 — VTNA reward rules: one table, no double payouts, Wallet › Rewards

Owner decision 2026-10-03: "You earn VTNA for real things you do yourself, once
per milestone, and for staying consistent." Four rules: first steps (once each),
habits (3/7/30-day streak milestones, once each), community (when others
respond, capped), and never-earns (anything Vitana does for you, purchases,
self-reported actions). Rule table: services/gateway/src/services/rewards/vtna-reward-rules.ts.

AC-1 One rule table defines every VTNA reward; every milestone pays exactly its rule amount (0 when it is not a rule).
TEST: services/gateway/test/vtid-04864-vtna-reward-rules.test.ts

AC-2 Nothing is paid twice: the diary streak celebrator and the milestone service share one key per tier; the AP-1301 welcome bonus shares the onboarding_complete key; Autopilot completion no longer pays 10 VTNA on top of the matching milestone.
TEST: services/gateway/test/vtid-04864-vtna-reward-rules.test.ts
TEST: services/gateway/test/diary-streak-celebrator.test.ts
Migration: supabase/migrations/20261003130000_vtid_04864_autopilot_completion_no_double_reward.sql (applied at the production step; staging shares the production database).

AC-3 The streak push never claims a credit that did not land (duplicate, failed credit, or the 14-day tier that is not a reward).
TEST: services/gateway/test/diary-streak-celebrator.test.ts

AC-4 GET /api/v1/wallet/reward-rules returns only rules something actually pays, the member's progress and recent rewards, and no display text.
TEST: services/gateway/test/vtid-04864-vtna-reward-rules.test.ts
CURL: unauthenticated GET returns 401 JSON (route mounted behind requireAuth) — staging-tests.json.

ROUTE_MOUNT: services/gateway/src/routes/wallet.ts (router mounted at /api/v1 by index.ts, owner 'wallet'; path-scoped requireAuth on /wallet)
FINAL_URL: GET /api/v1/wallet/reward-rules
CURL_PROOF: staging check in docs/validation/VTID-04864/staging-tests.json expects 401 application/json without a token; the signed-in read is proven by the community-app staging spec vtid-04864-wallet-reward-rules.

AC-5 Existing behaviour is unchanged elsewhere: all suites covering the touched files pass; typecheck and build are clean.
TEST: services/gateway/test (16 suites, outputs/jest.txt)

AC-6 Invites (owner decision 2026-10-03): 1,000 VTNA per invited friend who joins (10 per 30 days) and a one-time 10,000 VTNA bonus at 10 friends; the reward is ON by default in code (COMMUNITY_INVITE_REWARD_ENABLED='false' is the off switch; deploy workflows untouched); the old AP-0405 referral payout and the invite prompt copy use the same rule-table amount.
TEST: services/gateway/test/vtid-04864-vtna-reward-rules.test.ts
TEST: services/gateway/test/vtid-04508-community-invites.test.ts
TEST: services/gateway/test/services/automation-handlers-sharing-growth.test.ts

AC-7 Codex review fixes: the invite cap is atomic (claim_invite_reward(): per-inviter advisory lock + cap + signed_up->rewarded in one step, verified in PGlite); AP-0708 pays only approved VTNA rules (legacy types like product_review are not paid); the overview reads lifetime earned keys, the cap window and the recent list separately, so early milestones never read as unearned.
TEST: services/gateway/test/vtid-04508-community-invites.test.ts
TEST: services/gateway/test/services/automation-handlers-wallet-payments.test.ts
TEST: services/gateway/test/vtid-04864-vtna-reward-rules.test.ts
Evidence: outputs/pglite-claim-invite.txt (migration 20261003140000_vtid_04864_claim_invite_reward.sql).

Contract changes made on purpose (tests updated with a comment each):
- welcomeBonusEventId() now returns the onboarding_complete milestone key (was onboarding_welcome_bonus:<user>).
- celebrateDiaryStreak() reports wallet_credit 0 when nothing was credited (was the tier amount even on failure).
- Invite reward 200 -> 1,000 VTNA (vtid-04508 and AP-0405 tests updated).
