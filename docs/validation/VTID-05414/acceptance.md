# Acceptance — VTID-05414 (pm-reassign-idempotent-r2/reassign-noop-r2)
Plan: `.kiro/specs/pm-reassign-idempotent-r2/plan.md` (converged, policy `converged-auto-v1`, session 96fa58f8,
plan PR #4483). Supersedes `pm-reassign-idempotent/reassign-noop` (VTID-05363, to be retired).

| Plan item | Where | Test |
|---|---|---|
| 1 writer no-op guard, W1 + W2, no put/ref/PR on a no-op | `writers.ts` `laneChangeIsNoop`, `GithubRepoFileWriter.write` | `reassign-idempotent.test.ts` |
| 2 stale-ready target never `reviewer_seat` | `decide.ts` `reassignDecision` | `reassign-seat.test.ts` |
| 3 refuse introducing `seat == reviewer_seat` (pre-existing state still writable) | `writers.ts` `applyLaneChange` | `reassign-seat.test.ts` |
| 4 `'written' \| 'noop'`, status `unchanged` | `act.ts`, `types.ts` `ActStatus` | `reassign-idempotent.test.ts`; fakes in act/fallback/governance/loop tests return `'written'` |
| 6 staging pin `PM_AGENT_ENABLED=false` | `AWS-STAGE-DEPLOY-GATEWAY.yml:1225` | `kaf-staging-claude-available-wiring.test.ts` |

## Decisions taken
- `decide.test.ts` "ready >24h, no automation → reassign to next seat": the fixture's `reviewer_seat` was `exafyltd`,
  the same seat the test expected as the new `seat` (the invalid lane this lane forbids). The fixture now uses
  `reviewer_seat: hotmail`; the assertion (`to_actor: exafyltd`) is unchanged. The reviewer_seat case is covered in
  `reassign-seat.test.ts`.
- `observe-live.test.ts` two writer fixtures set `seat: exafyltd` on a lane with `reviewer_seat: exafyltd`; they now
  set `seat: jtadic`. What they assert (allowed keys, one log entry, W2 branch/PR) is unchanged.
- W2 reads `pm-agent/<slug>` when that ref exists, else `main` (plan R1-F3), so a no-op creates no ref.
