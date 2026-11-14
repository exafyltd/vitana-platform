# ci-queue-flood: stop the PM commit flood and cut PR-gate queue load

<!-- plan:begin -->
## Goal

Stop the staging project-manager (PM) loop from flooding vitana-platform PR checks, and make the three PR gates that never
cancel superseded runs cancel them. Owner instruction 2026-11-02: "fix it, execute this fix".

## Evidence (measured 2026-11-02, 11:20-11:45 UTC, read-only)

- vitana-platform had at least 1,000 queued runs (the query limit). 855 of them come from three gates with no concurrency
  block: STAGING-TESTS-REQUIRED (287), PHASE-2B-NAMING-ENFORCEMENT (286), ENFORCE-FRONTEND-CANONICAL-SOURCE (282).
- 737 queued runs come from 15 `pm-agent/*` branches. `pm-agent/operating-workflow` alone had 154.
- The 15 latest commits on `pm-agent/operating-workflow` came in two bursts (about 11:26 and 11:32 UTC), two to three
  seconds apart, each with the subject `pm: operating-workflow/<lane> update`.
- Writer: `GithubRepoFileWriter.write` (services/gateway/src/services/project-manager/writers.ts) makes one `client.put`
  per lane change, so each change is one commit on `pm-agent/<slug>`. Every commit is a `pull_request` synchronize event
  for an open PR. `applyLaneChange` (same file) always rewrites `updated` and appends a dated log section, so no content
  check can skip a write.
- 27 bookkeeping PRs are open, all updated between 10:49 and 11:33 UTC. The PM's types say these PRs merge once green
  (types.ts, W2 merge decision), so they stay open while their checks wait in the queue.
- The loop runs on staging only. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` sets `PM_AGENT_ENABLED=true` (line 1225)
  and `PM_MODE=live` (line 1226).
- Cancel rule: PR-GATE, UNIT, DEV-AUTOPILOT-IMPACT and PHASE-2B-DOC-GATE cancel superseded runs and hold 26 to 32 queued
  runs each. The three gates above hold about 285 each.
- REST budget: at 11:43 UTC the core budget was 0 of 5,000 (`gh api rate_limit`), and `gh run list` and `gh run cancel`
  returned HTTP 403. The loop reads GitHub on every tick.

## Decisions

1. Disable the loop, not only its writes. `services/gateway/src/index.ts:1882` starts the loop only when
   `pm.pmAgentEnabled() && pm.pmMode() !== 'off'`. `pmAgentEnabled()` is `PM_AGENT_ENABLED === 'true'`
   (config.ts:14-16). Setting `PM_AGENT_ENABLED=false` stops both writes and reads.
2. `dry_run` was rejected. `act.ts` performs no action outside `live` (header lines 5-6). In non-live modes the loop still
   runs `runDecideTick` with the GitHub observer (`loop.ts:64`; the observer is wired in `liveLoopDeps`), so the read load
   would continue.
3. Staging only. Production is not changed by this plan.
4. Gate hygiene is limited to concurrency, timeouts and checkout depth. Job ids and names do not change, so no
   branch-protection check name changes.
5. Accepted consequence: while `PM_AGENT_ENABLED=false`, staging gets no PM merges or parks. Merges follow the plan driver
   rule in `collaboration.md` section 7b until the PM is re-enabled.

## Lanes

### stop-pm-loop (executor: kiro)

- File: `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`. Lines 1225-1226: the `PM_AGENT_ENABLED` value `"true"` becomes
  `"false"`, and the `PM_MODE` value `"live"` becomes `"off"`.
- Verify after the staging deploy: GET `/api/v1/project-manager/mode` on the staging gateway reports `enabled: false`
  (routes/project-manager.ts:37). No new commit whose subject starts with `pm: ` appears on any `pm-agent/*` branch for
  30 minutes. STAGING-VERIFY passes on the merge commit.

### gate-hygiene (executor: kiro)

- Add this block to each of the three gate files:
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```
  This is the expression TEST-SUITE.yml already uses. Pushes to `main` are never cancelled.
- `.github/workflows/STAGING-TESTS-REQUIRED.yml`: keep `fetch-depth: 0` (line 28), because `check-pr` diffs base against
  head. Keep `timeout-minutes: 5` (line 24).
- `.github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml`: remove `fetch-depth: 0` (line 18), because the naming step reads only
  `.github/workflows/`. Add `timeout-minutes` to the job.
- `.github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` (`on: [pull_request]`, line 4): add `timeout-minutes` to job
  `validate`. Keep the build steps. Whether the validator needs the build is not verified here, so the build is not changed.
- Verify: each file parses as YAML; job ids and names are unchanged; on the lane PR, a second push cancels the first run of
  each gate.

## Out of scope (separate plans, sparred before use)

- PM write fix: skip lane updates that change no field the queue reads, and write at most one commit per plan per tick.
  Required before `PM_AGENT_ENABLED` is set back to `true`.
- vitana-v1 `STAGING-TESTS-REQUIRED.yml` has the same missing concurrency block. Its queue is small today.
- Scheduled workflows at a 15 to 30 minute cadence (E2E-ORB-MONITOR, ALERT-NEWDAY-BRIEFING-LOOP, ALERT-PUSH-DISPATCH-HEALTH,
  SCREEN-LOAD-TIMING).
- Concurrency capacity. GitHub caps standard runners at 20 concurrent jobs on Free and 40 on Pro.

## Risks

- Staging PM stops merging and parking until it is re-enabled (decision 5).
- A cancelled run of a superseded commit never reports a result. Merges read only the current head's runs.

## Test plan

- Local: parse the three gate files and the staging workflow with a YAML parser. Diff job ids and names against origin/main.
- CI: the lane PR's gates run, and a second push cancels the first run of each gate.
- Staging: STAGING-VERIFY on the merge commit, the mode endpoint check, and the 30-minute quiet check on `pm-agent/*`.
<!-- plan:end -->
