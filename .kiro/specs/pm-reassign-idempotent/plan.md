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

**Amendment 2026-10-28 (driver takeover, see `handoff.md`): a second cause keeps the loop alive.** The stale-ready
reassignment can write a lane the Collab handoff check rejects, so the bookkeeping PR never merges, `main` keeps the
stale lane, and the PM re-decides it on every tick. Observed (read-only, diagnosis 2026-10-28): #4370
(`pm-agent/commerce-step-owner`, 867 commits) `seat: exafy → exafyltd` with `reviewer_seat: exafyltd`; #4333
(`pm-agent/kiro-autonomy-fallback`, 8,118 commits) the same on 6 lanes; #4267 (`pm-agent/messenger-ux-v2`, 3,794
commits) on 3 lanes; #4249 (`pm-agent/sparring-floor-retry`, 1,069 commits) re-commits without a seat change.
## Premises (read-only, `exafyltd/vitana-platform` @ `origin/main` `28aaab2331`)
1. `services/gateway/src/services/project-manager/decide.ts:227-285` `reassignDecision`: a lane `in-review` with no
   completed review and `state_since` older than the window returns `reason: 'stale_review'`,
   `to_actor = nextActor(lane.reviewer_seat)`. The only no-op guard is `next.actor === lane.reviewer_seat`. When
   `reviewer_seat` is empty (the agent reviewer, no legacy seat), it returns the exceptions seat on every tick.
   `state_since` does not move, and nothing records that the reassignment already happened.
2. `services/gateway/src/services/project-manager/act.ts:279-291` `actReassign` always calls `laneWriter.write`, and
   `LaneFileWriter.write` returns `Promise<void>` (`act.ts:111-113`), so it cannot report a no-op.
3. `services/gateway/src/services/project-manager/writers.ts:42-62` `applyLaneChange` always sets `updated` and always
   appends a log entry, even when `next_actor`/`seat` already have the target value. `GithubRepoFileWriter.write`
   (`writers.ts:91-110`) always `put`s the result, i.e. one commit per tick.
4. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1225` upserts `{name:"PM_AGENT_ENABLED", value:"true"}`, so any
   staging gateway deploy would turn the PM back on before this fix is verified.
5. **(amendment)** `decide.ts:244-260` (`stale_ready`): `to_actor = nextActor(lane.seat)`, and the only guard is
   `next.actor === lane.seat`. `nextActor` never looks at `lane.reviewer_seat`: at the end of the area rotation it
   returns `claudeOrExceptions(claude)` (`decide.ts`), i.e. the exceptions seat `exafyltd` while Claude is
   unavailable. `actReassign` then sets `seat: <to_actor>` (`act.ts:286`, every `to_actor` except `claude`). When the
   lane's legacy `reviewer_seat` is that seat, the lane file has `seat == reviewer_seat`, which
   `scripts/collab/queue.mjs:227` (`validateLane`) rejects ("reviewer_seat must differ from seat"). The bookkeeping PR
   stays red, so it never merges.
6. **(amendment)** The observer reads lanes from `main` only (`observe-live.ts:293-327`), so while a bookkeeping PR is
   open the decider sees the old lane and re-issues the same decision every tick. The writer no-op guard (change 1)
   makes that repeat write nothing; change 2 makes the first write valid so the PR can merge.
## Change — one lane `reassign-noop` (vitana-platform)
1. `writers.ts`: export `laneChangeIsNoop(text, change)`, true when every front-matter key the change would set
   (`state`, `next_actor` after the `LANE_ACTORS` mapping, `seat`, `claimed_by` on `release_claim`) already has that
   value **and** the newest log entry of the file already has the same `change.log` text. `GithubRepoFileWriter.write`
   reads the file from the branch it would write (the PR head for W1, the bookkeeping branch `pm-agent/<slug>` for W2,
   `writers.ts:98`/`:105`) and returns `'noop'` without `put` (no commit, no push, no branch/PR creation) when it is a
   no-op, on both W1 and W2 paths.
2. **(amendment)** `decide.ts` `reassignDecision` (`stale_ready`): the target seat is never the lane's
   `reviewer_seat`. Walk the area rotation after `lane.seat` and take the first seat that differs from both `lane.seat`
   and `lane.reviewer_seat`; past the end, `claudeOrExceptions(claude)`. If that actor is `claude`, the decision is as
   today (`seat` unchanged, `next_actor: claude`). If it is a seat equal to `lane.reviewer_seat` (e.g. the exceptions
   seat), there is **no decision**: the lane stays `ready` and visible on the queue, no write. The `stale_review` path
   does not change `seat` (`act.ts:286`) and is unchanged by this item.
3. **(amendment)** `writers.ts` `applyLaneChange`: throws `invalid lane change: seat equals reviewer_seat` when the
   resulting front matter has `seat` equal to a non-empty `reviewer_seat`, so the PM never commits a lane file that
   `queue.mjs validateLane` rejects (the same rule as `queue.mjs:227`). `act` reports the error as today.
4. `act.ts`: `LaneFileWriter.write` returns `Promise<'written' | 'noop'>` (accepted from round 1, R1-F2). The test fakes
   and other implementations return `'written'`. `actReassign` returns `status: 'unchanged'` (added to the `ActResult`
   status union) when the writer reports `'noop'`, so the tick log does not claim a reassignment. `actMerge`,
   `actPark` and `actVerify` ignore the return value.
5. Dropped (round 1, R1-F1): the earlier `decide.ts` `stale_review` guard based on `next_actor` and the last log entry.
   `ObservedLane` has no `next_actor`, and the observer reads `main`, so it could not see the bookkeeping write; the
   writer guard (change 1) stops the pushes.
6. `AWS-STAGE-DEPLOY-GATEWAY.yml:1225`: the upsert value becomes `"false"`, so a deploy keeps the PM paused. Turning it
   back on is a later owner decision, after this lane is verified on staging. It is not part of this plan.
- Tests (red on base, green on head), in `services/gateway/test/project-manager/`:
  - `reassign-idempotent.test.ts`: two consecutive ticks over the same observed lane produce one write, then zero
    (`write` returns `'noop'`, `actReassign` status `unchanged`); writer with a fake client: same change twice → one
    `put`, on W1 and on W2.
  - **(amendment)** `reassign-seat.test.ts`: a `ready` lane past the window with `seat: exafy`, `reviewer_seat:
    exafyltd`, rotation `[exafy]`, Claude unavailable → no decision (base: decision `to_actor: exafyltd`); rotation
    `[exafy, exafyltd, jtadic]` → `to_actor: jtadic`; Claude available → `to_actor: claude`, `seat` unchanged; no
    `reviewer_seat` → `exafyltd` as today. `applyLaneChange` with a change that makes `seat == reviewer_seat` throws.
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
  `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, `docs/validation/VTID-*/**`. No protected gate file
  (`governance.ts` is not touched).
## Out of scope
- Closing the bloated `pm-agent/*` bookkeeping PRs (#4370, #4333, #4267, #4249) unmerged, so their log spam never
  reaches `main` — a backlog decision, done outside this lane.
- Re-enabling the PM.
- The PM moving an `executor: claude` lane off `seat: claude` (#4249) — separate finding.
<!-- plan:end -->
