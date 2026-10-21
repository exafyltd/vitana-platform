# Plan sparring record — VTID-04899 (shared with VTID-04900)

Plan hash (sha256 of the text between the plan markers): `2b138193550d45dba5ca04dd459b98ecaa2ac5f870d4ef8d0f34cf88503c1afc`. Partner: plan-sparring-partner, 2 rounds, CONVERGED. Owner approved in session 2026-10-05 ("Approved").

# Plan: a production-safe switch for the immediate Autopilot completion reward, and a What's New card that promises nothing inactive

Planner: Claude Code session (owner: d.stevanovic@exafy.io). Date: 2026-10-05.

<!-- plan:begin -->
## Owner request (2026-10-05)
Add `AUTOPILOT_ACTION_REWARD_ENABLED`. Production initially pinned `false`. Payout refuses `autopilot_action_done` when false. Wallet → Rewards uses the same flag. The 6-hour sweep stays independently controlled by `REWARD_SWEEP_ENABLED=false`; invite rewards stay independently controlled. Tests: payout disabled/enabled, UI visibility, interaction with the daily cap. Staging verification before production. No frontend production deploy. Assess the VTID-04878 "More ways to earn VTNA" What's New card: while Autopilot rewards are disabled it must not promise an inactive earning mechanism.

## Verified current state (code + read-only production)
- One rule, `autopilot_action_done` (5 VTNA, max 2 per UTC day, `window: 'day'`), paid immediately on a member's first completion of an Autopilot recommendation by exactly two callers, both through `claimCappedReward()` (`services/rewards/capped-reward.ts`): `POST /api/v1/autopilot/recommendations/:id/complete` (`routes/autopilot-recommendations.ts` ~L2712) and `completeSourceForCalendarEvent()` (`services/calendar-producers.ts` ~L390; used by the calendar ORB tools and community-autopilot `slot-due.ts`). No other payer (grep of `claim_capped_reward`/`claimCappedReward`).
- `claimCappedReward()` already returns `{ outcome: 'rule_off', credited: 0 }` without calling the RPC when `isRuleLive(rule, env)` is false. `isRuleLive()` today has a switch only for `invite_friend_joined`/`invited_friends_10` (`COMMUNITY_INVITE_REWARD_ENABLED`, on unless exactly `'false'`).
- Wallet → Rewards: the gateway's `buildRewardOverview()` (`reward-overview-service.ts`) lists `visibleRewardRules(env)` = rules where `isRuleLive` is true; the frontend (`VtnaRewardRules.tsx`, `useRewardRules`) renders exactly that list. So visibility is decided in the gateway; no frontend change is needed for it.
- The sweep (`reward-sweep.ts`) pays milestones, `live_room_15min` and `index_new_best`; never `autopilot_action_done`. Gate: `rewardSweepAllowed()` (`VITANA_ENV!=='staging'` and `REWARD_SWEEP_ENABLED!=='false'`). Production pins `REWARD_SWEEP_ENABLED=false` (VTID-04896, live task def :151).
- Production today (gateway e2a98f73 + frontend 5ad74d0): the overview lists `autopilot_action_done` (paid), and `live_room_15min` + `index_new_best` (NOT paid — only the sweep pays them and it is off). Frontend 5ad74d0 contains the VTID-04864 rules screen but not the VTID-04878 i18n keys for those three ids, so members likely see untranslated keys there today.
- Read-only production DB: 0 `autopilot_action_done` awards ever; last reward of any kind 2026-07-20; 0 Autopilot completions today.
- What's New: `src/whats-new/entries/vtna-earn-more-ways.json` (vitana-v1, VTID-04878, `added: 2026-10-05`) promises all three mechanisms ("Autopilot actions (up to 2 a day), 15 minutes in a live room (up to 3 a week), every new Vitana Index best (once a week)"), deep link `/wallet/rewards`. The gateway publishes an entry once the frontend build carrying it is live in production, at most one per day, never when `added` is older than 14 days; global kill switch `WHATS_NEW_AUTOPUBLISH=false`. The frontend is not in production, so nothing has been published.

## Decisions for the owner (my recommendation first)
- **D-1 flag semantics: fail closed.** `AUTOPILOT_ACTION_REWARD_ENABLED` pays only when exactly `'true'`. Production pins `"false"` explicitly; staging pins `"true"` (keeps staging's current behaviour and lets the suite prove "enabled"). A lost or mistyped value means off. (Alternative: on unless `'false'`, like the invite flag — rejected: a production env that loses the pin would start paying.)
- **D-2 sweep-paid rules follow the sweep switch on the Wallet (recommended, same VTID).** `live_room_15min` and `index_new_best` are listed only when `REWARD_SWEEP_ENABLED !== 'false'`. This is the same principle the owner set ("cannot advertise a disabled reward") and production advertises both today without paying them. Keyed on `REWARD_SWEEP_ENABLED` only (not `VITANA_ENV`), so staging's Wallet is unchanged. Because `isRuleLive()` is shared, `claimCappedReward()` also refuses these two rules (`rule_off`) while the switch is `false` — consistent, since the sweep is their only payer and is off then. Deliberate coupling, documented in the `isRuleLive()` header: for these two rules `REWARD_SWEEP_ENABLED` decides both payout and visibility, because their only payer is the sweep. If the sweep is ever split (e.g. milestones only), these two rules get their own switch in that change. Payout code is not touched by D-2 (the sweep's own gate already refuses). Milestones stay listed: milestone-service pays them immediately, independent of the sweep.
- **D-3 What's New card: remove the entry now** (vitana-v1). When the mechanisms are actually on in production, a new entry (new id, fresh `added` date — the 14-day rule needs one anyway) announces only what is live. Rejected alternatives: rewriting it to the active subset (no subset is active in production); the gateway kill switch `WHATS_NEW_AUTOPUBLISH=false` (global — would also block unrelated cards).

## Work items
### G. Gateway (vitana-platform, VTID A)
1. `vtna-reward-rules.ts` `isRuleLive()`: `autopilot_action_done` → `env.AUTOPILOT_ACTION_REWARD_ENABLED === 'true'`. With D-2: `live_room_15min`/`index_new_best` → `env.REWARD_SWEEP_ENABLED !== 'false'`. Invite branch unchanged. A header comment documents the three independent switches.
2. No change in `capped-reward.ts` or the two callers: they already go through `isRuleLive` → `rule_off`, no RPC, no wallet row, and the completion itself still succeeds (`credited 0`, OASIS `reward: 0`).
3. `AWS-PROD-DEPLOY-GATEWAY.yml`: the existing "Build task-definition (reward sweep off)" step becomes "rewards off" and also upserts `{name:"AUTOPILOT_ACTION_REWARD_ENABLED", value:"false"}`; the post-deploy "Verify reward sweep setting" step also checks `AUTOPILOT_ACTION_REWARD_ENABLED` against `false` (or an explicit `env_overrides` key), failing → automatic rollback. `AWS-STAGE-DEPLOY-GATEWAY.yml`: add `{name:"AUTOPILOT_ACTION_REWARD_ENABLED", value:"true"}` to the existing pin block. Regenerate `conversation-flag-pins.generated.ts`.
4. Tests (jest, new `test/vtid-XXXXX-autopilot-reward-switch.test.ts`, plus updating existing assertions that assume the rule is always live):
   - payout disabled: flag unset / `'false'` / `'TRUE'` → `claimCappedReward` returns `rule_off`, RPC never called; both callers credit 0 and the completion still returns ok;
   - payout enabled: `'true'` → RPC called with amount 5, cap 2, window `day`; outcomes `claimed` / `capped` / `duplicate` pass through;
   - daily cap interaction: enabled, the RPC's cap answer (3rd claim same UTC day) → `capped`, credited 0; disabled claims never call the RPC so they consume no cap and create no wallet row; completions made while disabled are not paid later (the item is then `already_completed`) — stated in the PR, and asserted via the route test;
   - UI visibility: `buildRewardOverview` lists `autopilot_action_done` only when the flag is `'true'`; with D-2, lists `live_room_15min`/`index_new_best` only when `REWARD_SWEEP_ENABLED !== 'false'`;
   - independence matrix: each of the three switches changes only its own rules (invite flag, sweep flag, autopilot flag), and `rewardSweepAllowed` is unchanged;
   - workflow: prod pins `false` before registration, the live check covers it, staging pins `true`, flag pins regenerated.
   The SQL cap itself stays covered by the existing `supabase/tests/vtid_04878_capped_reward.test.sql` (no SQL change).
   **Existing assertions that the fail-closed default changes (inventoried by grep of every gateway test naming the three rules or the visibility/claim functions):**
   - `test/vtid-04878-reward-earning.test.ts` ~L193-195: `buildRewardOverview(..., {} as any)` expects `autopilot_action_done` listed → pass `{ AUTOPILOT_ACTION_REWARD_ENABLED: 'true' }`.
   - `test/vtid-04878-reward-earning.test.ts` ~L217: `claimCappedReward(client, {..., ruleId: 'autopilot_action_done'})` uses the default `process.env` → pass `{ AUTOPILOT_ACTION_REWARD_ENABLED: 'true' }` as the env argument.
   Unaffected, checked: `vtid-04864-vtna-reward-rules.test.ts` (asserts the rule table and invite/milestone visibility only; `live_room_15min` stays visible with `{}` because `REWARD_SWEEP_ENABLED` is unset there); `vtid-04878-reward-routes.test.ts`, `routes/autopilot-recommendations*.test.ts` (they `jest.mock` `claimCappedReward`); the reward-earning live_room/index claims (process.env has no `REWARD_SWEEP_ENABLED`); vitana-v1 `VtnaRewardRules.test.tsx` (renders mock gateway data, never calls the gateway).
   The new test file defines one explicit env per case (`ON = { AUTOPILOT_ACTION_REWARD_ENABLED: 'true' }`, `OFF = {}`, sweep/invite variants) so a future switch changes only its own cases.
5. Change suite `docs/validation/<VTID A>/staging-tests.json`: the new jest file + existing reward tests; read-only probe that the overview route still answers 401 unsigned. Staging verification before any production step.
6. Production (after staging verify, with the owner's explicit approval at that point): `promote-staging` pinned to the merge commit (a code change, so not env-only). Before dispatch I restate the exact settings and the range `e2a98f73..<merge>` (includes `4de6a909`, VTID-04897, already live as config). Verify read-only: live task def has `AUTOPILOT_ACTION_REWARD_ENABLED=false` and `REWARD_SWEEP_ENABLED=false`, `COMMERCE_MCP_ENABLED=true` kept; build-info; and the Wallet overview as the test user (sign-in + GET only) no longer lists the three rules.

### W. What's New card (vitana-v1, VTID B)
1. Delete `src/whats-new/entries/vtna-earn-more-ways.json`; a vitest asserts no entry promises `autopilot_action_done`/live-room/Index earnings while those are off (simple text guard on the entries); `npm run whats-new` check stays green.
2. Staging: merge → frontend staging deploy → STAGING-VERIFY community-app (vitest + existing suites). No frontend production deploy.

## Out of scope
Enabling any reward; changing amounts/caps/SQL; the sweep; invite rewards; the frontend i18n keys for the three rules (they ship with the held frontend release); Partner Terms; frontend production deploy.

## Change class
standard (gateway logic, both deploy workflows, a production deploy).

## Scope
vitana-platform: `services/gateway/src/services/rewards/vtna-reward-rules.ts`, `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml`, `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, `conversation-flag-pins.generated.ts`, new + updated jest tests, `docs/validation/<VTID A>/`. vitana-v1: `src/whats-new/entries/vtna-earn-more-ways.json` (deleted), a vitest guard, `docs/validation/<VTID B>/`.
<!-- plan:end -->


## Planner responses — round 1
- F1 [minor] ACCEPTED — D-2 text and the `isRuleLive()` header state the deliberate coupling (payout + visibility for the two sweep-paid rules) and when it would be split.
- F2 [minor] ACCEPTED — the affected assertions are enumerated in G.4 (two, both in `vtid-04878-reward-earning.test.ts`); each other file checked and listed as unaffected with the reason.
- F3 [minor] ACKNOWLEDGED — already in G.3.
- F4 [major] ACCEPTED — inventory in G.4 (the cascade is two assertions, not five files: the route tests mock the claim, vtid-04864 asserts nothing about these rules, the frontend test uses mock data); new tests use explicit per-case env objects. Fail-closed stays (D-1) because a production env that loses the pin must not pay.
- F5 [minor] ACKNOWLEDGED — no ordering dependency: W removes an unpublished card; the Wallet listing is gateway-controlled (G).
- F6 [minor] ACKNOWLEDGED — correct as written (both production switches false → all three hidden).
- Q1: answered by F4/G.4.
- Q2: documented as a deliberate coupling (see F1); a split gets its own switch when it happens.

## Round 2 — partner status
F1 closed · F2 closed · F3 closed · F4 closed · F5 closed · F6 closed. No new blocker or major. Questions: none.

## Verdict
CONVERGED after 2 rounds (standard class, cap 3). Awaiting owner approval.
