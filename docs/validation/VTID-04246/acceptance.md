# VTID-04246 — Auto-approved Dev Autopilot executions are mergeable and retry-safe

Companion VTIDs in the same PR: VTID-04243 (turn-cap re-approval breaker),
VTID-04244 (fix-round turn floor), VTID-04247 (executor stamped at claim).

## What happened (2026-09-21, staging)

The owner approved all six held executions from VTID-04237 at 19:23 UTC. Six
PRs opened (#3543–#3548), every one failed `validate-pr` within a minute on
exit 10 (`no VTID in the title`), every one was reverted, and every self-heal
child died on the PR-flood guard. Full trace and the verbatim validator log:
`outputs/six-approved-prs-validator-exit-10.txt`.

Four independent defects stacked:

1. **No VTID.** `autoApproveTick` never activates a VTID for the finding, so
   `applyPrContract` skips itself and the PR carries the `VTID-DA-<exec8>`
   placeholder. The on-ramp (VTID-04005) and the self-healing injector
   allocate; auto-approve was the one producer that did not. (VTID-04246)
2. **No fix mode.** The rows carry no `metadata.executor` (the mode is
   resolved from the ECS task env), and `isFixModeEligible` requires it, so
   the bridge reverted instead of continuing the PR — and the child then hit
   the flood guard because the reverted parent still holds `pr_url`. (VTID-04247)
3. **Turn-cap retries.** The npm-audit chain burned ≈5.5 M input tokens per
   attempt and was re-approved after each failure until AUTO_RETRY_CAP. (VTID-04243)
4. **No repair budget.** A run that called `finish` at turn 118 got a 2-turn
   fix round (`AGENT_MAX_TURNS - totalTurns`). (VTID-04244)

## Acceptance criteria

AC-1 Before `approveAutoExecute`, both auto-approve passes ensure the finding has a real VTID: `allocate_global_vtid` mints it, the ledger row is registered `in_progress`/`approved` with `metadata.source='dev-autopilot-auto-approve'` (never `autonomous_execution`), and the finding is stamped `activated_vtid`/`activated_at` with its status untouched; any failure skips the approval.
TEST: services/gateway/test/vtid-04246-auto-approve-vtid-allocation.test.ts

AC-2 A finding whose terminal-failure rows in the 24 h window include a turn-cap error is snoozed 7 days with a `dev_autopilot.finding.snoozed` event and is not re-approved, before the AUTO_RETRY_CAP count is consulted.
TEST: services/gateway/test/vtid-04243-turn-cap-breaker.test.ts

AC-3 Every fix round after the first is budgeted at least `AGENT_FIX_ROUND_MIN_TURNS` (default 15, env-tunable) turns; round 0 keeps the full cap.
TEST: services/gateway/test/vtid-04244-fix-round-turn-floor.test.ts

AC-4 The cooling→running claim stamps `metadata.executor` from the process pin when the row has none, so a stamped auto-approved parent is fix-mode eligible at stage `ci`; a process with no pin stamps nothing.
TEST: services/gateway/test/vtid-04247-claim-executor-stamp.test.ts

AC-5 The neighbouring executor suites (fix mode, PR-flood guard, agent loop, VTID-04237 pins) still pass.
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts
TEST: services/gateway/test/dev-autopilot-runexec-pr-flood-guard.test.ts
TEST: services/gateway/test/autopilot-agent-loop.test.ts
TEST: services/gateway/test/vtid-04237-executor-agent-hold-pinned.test.ts

AC-6 Live, after this deploys to staging: the next auto-approved execution's PR title carries a real `VTID-0xxxx`, its body the `VTID:` line and the evidence pack, and `validate-pr` passes; a CI failure on it spawns a fix-mode child (`metadata.fix_mode`) instead of a revert.
TEST: services/gateway/test/vtid-04246-auto-approve-vtid-allocation.test.ts

## OASIS

OASIS_PROOF: new event type `dev_autopilot.finding.snoozed` (source `dev-autopilot`, status `warning`, payload `{finding_id, reason:'turn_cap_failure', snoozed_until}`) emitted by the VTID-04243 breaker; every auto-approved finding now also produces a `vtid_ledger` row (`metadata.source='dev-autopilot-auto-approve'`). Verify on staging after deploy: `select * from oasis_events where topic='dev_autopilot.finding.snoozed' order by created_at desc limit 5;` and `select vtid,title,status,spec_status from vtid_ledger where metadata->>'source'='dev-autopilot-auto-approve' order by created_at desc limit 5;`.

## Results

| AC | Result |
|---|---|
| AC-1 | MET — 5 allocator tests + 3 wiring contracts green |
| AC-2 | MET — breaker unit tests + tick wiring contract green |
| AC-3 | MET — budget tests + runner wiring contract green |
| AC-4 | MET — stamp tests incl. the live pre-fix shape (not eligible) vs stamped (eligible) |
| AC-5 | MET — 8 suites / 71 tests green; broader sweep in `outputs/sweep.txt` |
| AC-6 | NOT YET — needs the staging deploy of this merge plus one auto-approved execution; recorded in a follow-up row when observed |

## Not fixed here, stated plainly

- The six findings behind #3543–#3548 are now blocked from re-approval by the
  stranded-PR guard (their parents are `reverted` with `pr_url` set). Clearing
  them (archive the parents, or let the owner re-run) is a separate operator
  decision; the code fix here prevents the next batch from dying the same way.
- The `services/gateway/tests/` allow-scope entry the agent flagged in #3548
  (never collected by jest) is a separate cleanup.
