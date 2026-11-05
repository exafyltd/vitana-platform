---
lane: sv-cwd
state: in-review
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - docs/validation/VTID-05515/staging-tests.json
  - docs/validation/VTID-05516/staging-tests.json
  - docs/validation/VTID-05518/staging-tests.json
claimed_by: kiro-exafy-202611052138-50a6
branch: kiro/agentic-delivery/sv-cwd
pr: https://github.com/exafyltd/vitana-platform/pull/4720
updated: 2026-11-05T22:02Z
vtid: VTID-05564
---
# Lane `sv-cwd`: fix forward of the gateway STAGING-VERIFY (three manifests run Jest from the wrong folder)
Tasks in `tasks.md` (group `<!-- lane: sv-cwd -->`). VTID from PLAN-SPAR (a late lane of the converged plan); never by
hand.

Every gateway STAGING-VERIFY since 2026-11-05T14:57Z ended `failed`, the run on this plan's merge commit `51c2bead07`
(lane prerequisites, run 42078889519) included. In each run the only failures are the `existing` suites of VTID-05515,
VTID-05516 and VTID-05518 (plan eng-platform-p01): their refs `npx jest test/<file>.test.ts` carry no `"cwd"`, so
`run.mjs` runs them from the repository root (`run.mjs:300-301`), Jest uses the root configuration and cannot parse the
gateway's TypeScript tests ("Jest failed to parse a file"). Run from `services/gateway` the same four files pass. Each
manifest gets `"cwd": "services/gateway"` and nothing else. Without this, no gateway change of this plan can reach a passed
STAGING-VERIFY (driver.md step 7, fix forward through `_plan`).

## Log
### 2026-11-05T21:35Z · kiro-exafy-202611041929-802c · created → ready
Lane added through `_plan` by the plan driver as the fix forward of STAGING-VERIFY run 42078889519 (merge commit
`51c2bead07`, lane prerequisites). Next: PLAN-SPAR allocates its VTID; a builder of seat `exafy` that is not the driver
claims it; the driver requests the reviewer agent. It lands before lane `scm-webhook` of eng-gitlab-m2 deploys the gateway.

### 2026-11-05T21:34Z · ci-plan-spar · ready (VTID allocated)
VTID-05564 allocated after policy approval (converged-auto-v1).

### 2026-11-05T21:58Z · kiro-exafy-202611052138-50a6 · ready → executing
Claimed by builder `kiro-exafy-202611052138-50a6` (seat `exafy`, not the driver) on base `d73fec53f9`. Built V1-V4: each of
the three manifests gains `"cwd": "services/gateway"` in its `existing` test, nothing else. Red on base: a replay of
`runExisting` runs the refs from the repository root, 0 of 3 suites pass (4 of 4 files fail to run, 0 tests). Green: the
same replay runs them in `services/gateway`, 3 of 3 suites, 55 of 55 tests; `lib.validateManifest` ok on each;
staging-verify script tests 103/103. Decisions in `docs/validation/VTID-05564/acceptance.md`.

### 2026-11-05T22:02Z · kiro-exafy-202611052138-50a6 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4720 open; preflight passed. Next: the driver requests the reviewer agent.
