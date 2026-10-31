---
change_class: light
---
# plan(pm-reassign-idempotent-r2): PM stale-review reassignment writes nothing when nothing changed (re-plan, kiro executor)
<!-- plan:begin -->
## Why a re-plan
This plan **supersedes `pm-reassign-idempotent/reassign-noop` (VTID-05363)**, converged and merged in #4396
(`9816df6d`). VTID-05363 is to be retired (terminalized `cancelled` by the PM or the exceptions seat once this plan's
lane has its own VTID); this plan does not touch the ledger. The old lane is stuck: its accepted finding R2-F2
(`.kiro/specs/pm-reassign-idempotent/sparring/responses-2.md`) needs `'unchanged'` in the closed `ActStatus` union
(`services/gateway/src/services/project-manager/types.ts:423-440`), but `types.ts` is not in the old lane's `paths`.
A Kiro `_plan` commit may not edit an existing lane file (`scripts/collab/queue.mjs:585-591`), and only a Claude
session may widen an `executor: claude` lane's `paths` (`queue.mjs:679-684`); Claude is unavailable. PLAN-SPAR does
not re-spar a converged plan, so a new slug gets a fresh sparring session and a CI-allocated VTID (the
`mt-frontend-brand-r2` pattern, #4317). The content below is the converged plan of `pm-reassign-idempotent`
unchanged, except: the lane is `executor: kiro` (seat `exafyltd`, reviewer agent) and its `paths` include `types.ts`.
Every existing `pm-reassign-idempotent` file stays unchanged.
## Problem
The PM agent (staging gateway, `PM_AGENT_ENABLED=true`, `PM_MODE=live`) re-pushed a `pm: <slug>/<lane> update`
commit to about 20 `pm-agent/<slug>` branches every ~4 min. Each commit only re-appended the same log line,
`reassign review →exafyltd (stale_review, Claude unavailable)`, and bumped `updated:`. On
`pm-agent/matches-scroll-end` the lane file grew to 1,764 lines. Each push started ~8 `pull_request` workflows
(~1,300 runs/h, all as `exafyltd`), which used up the GitHub core API quota. PLAN-SPAR's partner `read_file`/`list_dir`
then failed. The owner had the PM paused on 2026-10-27: staging task def `vitana-gateway:965`,
`PM_AGENT_ENABLED=false`.
A second cause keeps the loop alive: the stale-ready reassignment can write a lane the Collab handoff check rejects
(`seat == reviewer_seat`), so the bookkeeping PR never merges, `main` keeps the stale lane, and the PM re-decides it on
every tick. Observed (read-only): #4370 (`pm-agent/commerce-step-owner`) `seat: exafy → exafyltd` with
`reviewer_seat: exafyltd`; #4333 (`pm-agent/kiro-autonomy-fallback`) the same on 6 lanes; #4267
(`pm-agent/messenger-ux-v2`) on 3 lanes; #4249 (`pm-agent/sparring-floor-retry`) re-commits without a seat change.
## Premises (read-only, `exafyltd/vitana-platform` @ `origin/main` `c810ca1a49`)
1. `services/gateway/src/services/project-manager/decide.ts:227-285` `reassignDecision`: a lane `in-review` with no
   completed review and `state_since` older than the window returns `reason: 'stale_review'`,
   `to_actor = nextActor(lane.reviewer_seat)`. The only no-op guard is `next.actor === lane.reviewer_seat`
   (`decide.ts:270`). `state_since` does not move, and nothing records that the reassignment already happened.
2. `act.ts:279-291` `actReassign` always calls `laneWriter.write`, and `LaneFileWriter.write` returns
   `Promise<void>` (`act.ts:111-113`), so it cannot report a no-op.
3. `writers.ts:43-62` `applyLaneChange` always sets `updated` (`:57`) and always appends a log entry (`:61`), even
   when `next_actor`/`seat` already have the target value. `GithubRepoFileWriter.write` (`writers.ts:91-110`) always
   `put`s the result (`:101` W1, `:108` W2), i.e. one commit per tick.
4. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1225` upserts `{name:"PM_AGENT_ENABLED", value:"true"}`, so any
   staging gateway deploy would turn the PM back on before this fix is verified.
5. `decide.ts:244-261` (`stale_ready`): `to_actor = nextActor(lane.seat)` (`:248`), and the only guard is
   `next.actor === lane.seat` (`:249`). `nextActor` (`:233-241`) never looks at `lane.reviewer_seat`: at the end of
   the area rotation it returns `claudeOrExceptions(claude)`, i.e. the exceptions seat `exafyltd` while Claude is
   unavailable. `actReassign` then sets `seat: <to_actor>` (`act.ts:286`). When the lane's legacy `reviewer_seat` is
   that seat, the lane file has `seat == reviewer_seat`, which `scripts/collab/queue.mjs:227` (`validateLane`)
   rejects. The bookkeeping PR stays red, so it never merges.
6. The observer reads lanes from `main` only (`observe-live.ts`), so while a bookkeeping PR is open the decider sees
   the old lane and re-issues the same decision every tick. Change 1 makes that repeat write nothing; change 2 makes
   the first write valid so the PR can merge.
7. `types.ts:423-440` `ActStatus` is a closed union without `'unchanged'` (old R2-F2).
## Change — one lane `reassign-noop-r2` (vitana-platform)
1. `writers.ts`: export `laneChangeIsNoop(text, change)`, true when every front-matter key the change would set
   (`state`, `next_actor` after the `LANE_ACTORS` mapping, `seat`, `claimed_by` on `release_claim`) already has that
   value **and** the newest log entry's body already equals `change.log`. It never compares `updated:` or the log
   heading timestamp, and runs before `applyLaneChange` (old R2-F1). `GithubRepoFileWriter.write` reads the file from
   the branch it would write (PR head for W1; for W2 `pm-agent/<slug>` when that ref exists, else `main`) and, when
   it is a no-op, returns `'noop'` before `client.put`, before `ensureBookkeepingBranch` creates a ref and before
   `ensureBookkeepingPull` (no commit, no push, no branch, no PR), on both W1 and W2 (R1-F3).
2. `decide.ts` `reassignDecision` (`stale_ready`): the target seat is never the lane's `reviewer_seat`. Walk the area
   rotation after `lane.seat` and take the first seat that differs from both `lane.seat` and `lane.reviewer_seat`;
   past the end (or `lane.seat` not in the rotation), `claudeOrExceptions(claude)`. If that actor is `claude`, the
   decision is as today (`seat` unchanged, `next_actor: claude`). If it is a seat equal to `lane.seat` or to a
   non-empty `lane.reviewer_seat`, there is **no decision**: the lane stays `ready` and visible on the queue, no
   write. The `stale_review` path is unchanged by this item.
3. `writers.ts` `applyLaneChange`: throws `invalid lane change: seat equals reviewer_seat` only when **this change
   introduces** it: `change.seat` is defined, differs from the file's current `seat`, and equals the file's non-empty
   `reviewer_seat` (the rule of `queue.mjs:227`). A lane that already carries `seat == reviewer_seat` (pre-existing
   bad state on a bookkeeping branch) still accepts other PM writes (park, done, verify, a `next_actor`-only
   change), so the guard never blocks them (R1-F1). `act` reports the error as today.
4. `act.ts`: `LaneFileWriter.write` returns `Promise<'written' | 'noop'>`. Every existing implementation returns
   `'written'`, including the `FakeLaneWriter` in `test/project-manager/act.test.ts:82-87` and any other test fake
   implementing `LaneFileWriter` (R1-F2). `actReassign` returns `status: 'unchanged'` when the writer reports `'noop'`; `types.ts` adds
   `'unchanged'` to `ActStatus`. `actMerge`, `actPark` and `actVerify` ignore the return value.
5. No `decide.ts` `stale_review` guard (dropped in the old plan's round 1, R1-F1: `ObservedLane` has no `next_actor`
   and the observer reads `main`); the writer guard stops the pushes.
6. `AWS-STAGE-DEPLOY-GATEWAY.yml:1225`: the upsert value becomes `"false"`, so a deploy keeps the PM paused.
   Re-enabling is a later owner decision after STAGING-VERIFY. Not part of this plan.
- Tests (red on base, green on head), in `services/gateway/test/project-manager/`:
  - `reassign-idempotent.test.ts`: two consecutive ticks (different `now`) over the same observed lane produce one
    write, then zero (`write` returns `'noop'`, `actReassign` status `unchanged`); writer with a fake client: same
    change twice → one `put`, on W1 and on W2; a W2 no-op calls no `put`, `createRef` or `createPull`.
  - `reassign-seat.test.ts`: a `ready` lane past the window with `seat: exafy`, `reviewer_seat: exafyltd`, rotation
    `[exafy]`, Claude unavailable → no decision (base: `to_actor: exafyltd`); rotation `[exafy, exafyltd, jtadic]` →
    `to_actor: jtadic`; Claude available → `to_actor: claude`; no `reviewer_seat` → `exafyltd` as today.
    `applyLaneChange` with a change that makes `seat == reviewer_seat` throws; on a lane that already has
    `seat == reviewer_seat`, a park (or `next_actor`-only) change does not throw.
  - `kaf-staging-claude-available-wiring.test.ts`: the existing assertion stays; a new one pins
    `{name:"PM_AGENT_ENABLED", value:"false"}`.
## Test plan
- `cd services/gateway && npx jest test/project-manager test/kaf-staging-claude-available-wiring.test.ts` green, the
  new tests red on base (red output in `docs/validation/<VTID>/`); `npm run test:operator` green.
- Staging (read-only): `docs/validation/<VTID>/staging-tests.json`, `kind: existing`, the jest suites above. After the
  staging gateway deploy, GET `/api/v1/admin/build-info` contains the merge commit, and the task definition still has
  `PM_AGENT_ENABLED=false`.
- The PM stays paused.
## Lanes
- `reassign-noop-r2` (vitana-platform, `executor: kiro`, seat `exafyltd`, area `platform`, `reviewer_seat:
  agent:vitana-lane-reviewer`, `depends_on: []`). The reviewer agent lets a Kiro lane change the governance path
  `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` (not a protected gate file; `governance.ts` is not touched). Paths:
  `services/gateway/src/services/project-manager/{decide,act,writers,types}.ts`,
  `services/gateway/test/project-manager/**`, `services/gateway/test/kaf-staging-claude-available-wiring.test.ts`,
  `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, `docs/validation/VTID-*/**`.
## Out of scope
- Retiring VTID-05363 / parking `pm-reassign-idempotent/reassign-noop` as superseded (PM or exceptions seat, after
  this plan converges).
- Closing the bloated `pm-agent/*` bookkeeping PRs (#4370, #4333, #4267, #4249) unmerged.
- Re-enabling the PM.
- The PM moving an `executor: claude` lane off `seat: claude` (#4249) — separate finding.
<!-- plan:end -->
