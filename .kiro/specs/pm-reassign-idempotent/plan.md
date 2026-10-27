---
change_class: light
---
# plan(pm-reassign-idempotent): the PM's stale-review reassignment writes nothing when nothing changed
<!-- plan:begin -->
## Problem
The PM agent (staging gateway, `PM_AGENT_ENABLED=true`, `PM_MODE=live`) re-pushed a `pm: <slug>/<lane> update`
commit to about 20 `pm-agent/<slug>` branches every ~4 min. Each commit only re-appended the same log line,
`reassign review →exafyltd (stale_review, Claude unavailable)`, and bumped `updated:`. On
`pm-agent/matches-scroll-end` the lane file grew to 1,764 lines. Each push started ~8 `pull_request` workflows
(~1,300 runs/h, all as `exafyltd`), which used up the GitHub core API quota. PLAN-SPAR's partner `read_file`/`list_dir`
then failed (0 of 16 reads OK, sessions 78d00a62/6a54aedf). The owner had the PM paused on 2026-10-27: staging task def
`vitana-gateway:965`, `PM_AGENT_ENABLED=false`. After that there were 0 `pm-agent/*` runs, against 99 in the 20 min
before.

## Premises (read-only, `exafyltd/vitana-platform` @ the PR base)
1. `services/gateway/src/services/project-manager/decide.ts:227-285` `reassignDecision`: a lane `in-review` with no
   completed review and `state_since` older than the window returns `reason: 'stale_review'`,
   `to_actor = nextActor(lane.reviewer_seat)`. The only no-op guard is `next.actor === lane.reviewer_seat`. When
   `reviewer_seat` is empty (the agent reviewer, no legacy seat), it returns the exceptions seat on every tick.
   `state_since` does not move, and nothing records that the reassignment already happened.
2. `services/gateway/src/services/project-manager/act.ts:280-291` `actReassign` always calls `laneWriter.write`.
3. `services/gateway/src/services/project-manager/writers.ts:42-62` `applyLaneChange` always sets `updated` and always
   appends a log entry, even when `next_actor`/`seat` already have the target value. `GithubRepoFileWriter.write`
   (`writers.ts:91-110`) always `put`s the result, i.e. one commit per tick.
4. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1225` upserts `{name:"PM_AGENT_ENABLED", value:"true"}`, so any
   staging gateway deploy would turn the PM back on before this fix is verified.

## Change — one lane `reassign-noop` (vitana-platform)
- `writers.ts`: export `laneChangeIsNoop(text, change)`, true when every front-matter key the change would set
  (`state`, `next_actor` after the `LANE_ACTORS` mapping, `seat`, `claimed_by` on `release_claim`) already has that
  value **and** the newest log entry of the file already has the same `change.log` text. `GithubRepoFileWriter.write`
  returns without `put` (no commit, no push, no branch/PR creation) when it is a no-op, on both W1 and W2 paths.
- `decide.ts` `reassignDecision` (stale_review): no decision when the lane's `next_actor` already equals the mapped
  target actor and the lane's last log entry is a PM reassign to that actor (the observation already carries the
  log). This is defence in depth: the writer guard alone stops the pushes.
- `act.ts` `actReassign`: returns `status: 'unchanged'` when the writer reports a no-op, so the tick log does not
  claim a reassignment.
- `AWS-STAGE-DEPLOY-GATEWAY.yml:1225`: the upsert value becomes `"false"`, so a deploy keeps the PM paused. Turning it
  back on is a later owner decision, after this lane is verified on staging. It is not part of this plan.
- Tests (red on base, green on head), in `services/gateway/test/project-manager/`:
  - `reassign-idempotent.test.ts`: two consecutive ticks over the same observed lane produce one write, then zero.
  - `applyLaneChange` + writer with a fake client: same change twice → one `put`.
  - The `kaf-staging-claude-available-wiring.test.ts` assertion stays, and a new assertion pins
    `{name:"PM_AGENT_ENABLED", value:"false"}`.

## Test plan
- `cd services/gateway && npx jest test/project-manager test/kaf-staging-claude-available-wiring.test.ts` green, with
  the new tests red on base.
- Staging (read-only): `docs/validation/<VTID>/staging-tests.json`, `kind: existing`, the jest suites above. After the
  staging gateway deploy, GET `/api/v1/admin/build-info` contains the merge commit, and the task definition still has
  `PM_AGENT_ENABLED=false`.
- The PM stays paused. Re-enabling it is the owner's call after STAGING-VERIFY passes.

## Lanes
- `reassign-noop` (vitana-platform, seat `exafy`, area `platform`, executor `claude`, `depends_on: []`). It is
  `executor: claude` because it changes `.github/**`; while Claude is unavailable it goes to the exceptions seat
  `exafyltd`. Paths: `services/gateway/src/services/project-manager/{decide,act,writers}.ts`,
  `services/gateway/test/project-manager/**`, `services/gateway/test/kaf-staging-claude-available-wiring.test.ts`,
  `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, `docs/validation/VTID-*/**`. No protected gate file.

## Out of scope
- Cleaning up the bloated `pm-agent/*` bookkeeping branches and PRs (close them once the PM is back on).
- Re-enabling the PM.
<!-- plan:end -->
