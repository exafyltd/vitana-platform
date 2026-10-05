# VTID-04899 — a production-safe switch for the immediate Autopilot completion reward

Owner decision 2026-10-05 (plan sparred, D-1/D-2 approved).

AC-1 `autopilot_action_done` pays only when `AUTOPILOT_ACTION_REWARD_ENABLED` is exactly `'true'` (fail closed); otherwise the claim answers `rule_off`, never reaches the database and credits nothing; the completion itself still succeeds.
TEST: services/gateway/test/vtid-04899-autopilot-reward-switch.test.ts — "payout: the switch is fail closed"; services/gateway/test/vtid-04878-reward-routes.test.ts — "VTID-04899: with the reward switched off the claim answers rule_off, pays 0, and the completion still succeeds"

AC-2 The daily cap (2 per UTC day) still holds when enabled; disabled claims use none of it; completions made while disabled are not paid later.
TEST: services/gateway/test/vtid-04899-autopilot-reward-switch.test.ts — "interaction with the daily cap (2 per UTC day)"

AC-3 Wallet → Rewards lists `autopilot_action_done` only while its switch is `'true'`; `live_room_15min`/`index_new_best` only while `REWARD_SWEEP_ENABLED` is not `'false'`; with production's pins none of the three is advertised.
TEST: services/gateway/test/vtid-04899-autopilot-reward-switch.test.ts — "Wallet → Rewards uses the same switch"

AC-4 Each switch (autopilot, sweep, invite) changes only its own rules; the sweep gate is unchanged.
TEST: services/gateway/test/vtid-04899-autopilot-reward-switch.test.ts — "each switch changes only its own rules"

AC-5 Production pins `false` before registration and the live post-deploy check covers it (rollback on mismatch); staging pins `true`; flag pins regenerated; every run step stays valid bash under the size limit.
TEST: services/gateway/test/vtid-04899-autopilot-reward-switch.test.ts — "deploy workflows"; services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts; services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts
