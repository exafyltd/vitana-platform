# ci-queue-flood-r2: stop the PM commit flood and cut PR-gate queue load

<!-- plan:begin -->
## Goal

Stop the staging project-manager (PM) loop from flooding vitana-platform PR checks and from exhausting the GitHub REST
budget. Make the three PR gates that never cancel superseded runs cancel them. Owner instruction 2026-11-02: "fix it,
execute this fix", then "you decide and continue".

## Supersedes

This plan replaces `ci-queue-flood` (plan PR #4607). That session escalated on round 1 with `evidence_floor_not_met`
(zero premise checks backed by read_file results). The reason is not retryable on main
(`services/gateway/src/services/plan-sparring/plan-sparring-service.ts`, `RETRYABLE_REASONS`). #4607 stays open as the
escalation record.

## Evidence (read-only, 2026-11-02)

- Queue: at least 1,000 queued platform runs at about 11:20 UTC. 855 came from three gates with no concurrency block:
  STAGING-TESTS-REQUIRED (287), PHASE-2B-NAMING-ENFORCEMENT (286), ENFORCE-FRONTEND-CANONICAL-SOURCE (282).
- Writes: 737 queued runs came from 15 `pm-agent/*` branches. The 15 latest commits on `pm-agent/operating-workflow`
  came in two bursts, about 11:26 and 11:32 UTC. Later, 29 commits landed on that branch in 20 minutes.
- Reads: the core REST budget (5,000 per hour) was exhausted at 11:43 UTC and again at 12:13 UTC.
- Mechanism (writes): `GithubRepoFileWriter.write` (services/gateway/src/services/project-manager/writers.ts) makes one
  `client.put` per lane change. `applyLaneChange` always rewrites `updated` and appends a dated log section, so no
  content check can skip a write.
- Mechanism (reads): the non-live branch of the loop calls `runDecideTick` with the GitHub observer (loop.ts:64;
  `liveLoopDeps` wires `GithubObserver`). Dry-run therefore keeps the reads.
- Mechanism (gates): STAGING-TESTS-REQUIRED.yml, PHASE-2B-NAMING-ENFORCEMENT.yml and ENFORCE-FRONTEND-CANONICAL-SOURCE.yml
  have no `concurrency` block. PR-GATE, UNIT, DEV-AUTOPILOT-IMPACT and PHASE-2B-DOC-GATE do cancel superseded runs.

## Decisions

1. Disable the loop, not only its writes. `services/gateway/src/index.ts:1882` starts the loop only when
   `pm.pmAgentEnabled() && pm.pmMode() !== 'off'`. `pmAgentEnabled()` returns `env.PM_AGENT_ENABLED === 'true'`
   (config.ts:15). Setting `PM_AGENT_ENABLED=false` stops both writes and reads.
2. Reject `dry_run`. It stops the writes but keeps the reads (loop.ts:64).
3. Staging only. Production is not changed.
4. Gate hygiene is limited to concurrency, timeouts and checkout depth. Job ids and names do not change.
5. Accepted consequence: while the loop is off, staging gets no PM merges or parks. Merges follow `collaboration.md`
   section 7b until the PM is re-enabled.

## Premises for the partner to verify (read_file)

- P1: `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` lines 1225 and 1226 set `PM_AGENT_ENABLED` to `"true"` and
  `PM_MODE` to `"live"`.
- P2: `services/gateway/src/index.ts` line 1882 gates the PM loop on `pm.pmAgentEnabled() && pm.pmMode() !== 'off'`.
- P3: `services/gateway/src/services/project-manager/config.ts` line 15 returns `env.PM_AGENT_ENABLED === 'true'`.
- P4: `services/gateway/src/services/project-manager/loop.ts` line 64 calls `runDecideTick` with `deps.observer` in the
  non-live branch.
- P5: `.github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml` line 18 sets `fetch-depth: 0`, and the file has no
  `concurrency` block.

## Lanes

### stop-pm-loop (executor: kiro)

- File: `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`. Lines 1225 and 1226: the `PM_AGENT_ENABLED` value `"true"`
  becomes `"false"`, and the `PM_MODE` value `"live"` becomes `"off"`.
- Verify after the staging deploy: GET `/api/v1/project-manager/mode` on the staging gateway reports `enabled: false`
  (routes/project-manager.ts). No new commit with a subject starting `pm: ` appears on any `pm-agent/*` branch for 30
  minutes. STAGING-VERIFY passes on the merge commit.

### gate-hygiene (executor: kiro)

- Add this block to each of the three gate files:
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```
  This is the expression TEST-SUITE.yml already uses. Pushes to `main` are never cancelled.
- STAGING-TESTS-REQUIRED.yml: keep `fetch-depth: 0` (line 28), because `check-pr` diffs base against head. Keep
  `timeout-minutes: 5`.
- PHASE-2B-NAMING-ENFORCEMENT.yml: remove `fetch-depth: 0` (line 18). Add `timeout-minutes` to the job.
- ENFORCE-FRONTEND-CANONICAL-SOURCE.yml (`on: [pull_request]`): add `timeout-minutes` to job `validate`. Keep the build
  steps.
- Verify: each file parses as YAML; job ids and names are unchanged; on the lane PR a second push cancels the first run
  of each gate.

## Out of scope (separate plans, sparred before use)

- PM write fix: skip updates that change no field the queue reads, and write at most one commit per plan per tick.
  Required before `PM_AGENT_ENABLED` returns to `true`.
- PM read load: reduce observer calls per tick. Required before the loop is re-enabled.
- vitana-v1 `STAGING-TESTS-REQUIRED.yml` has the same missing concurrency block.
- Scheduled workflows at a 15 to 30 minute cadence.

## Risks

- Staging PM stops merging and parking until it is re-enabled (decision 5).
- A cancelled run of a superseded commit never reports. Merges read only the current head's runs.

## Test plan

- Local: parse the edited workflow files as YAML, and diff job ids and names against origin/main.
- CI: the lane PR's gates run, and a second push cancels the first run of each gate.
- Staging: STAGING-VERIFY on the merge commit, the mode endpoint check, and the 30-minute quiet check on `pm-agent/*`.
<!-- plan:end -->
