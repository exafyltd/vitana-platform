# Tasks — mt-queue-superseded-close
Authoritative plan: `plan.md`. VTIDs: allocated by PLAN-SPAR on convergence.

<!-- lane: superseded-close -->
## superseded-close
- [ ] Q1. Tests first (`scripts/collab/queue.test.mjs`), recorded red on `origin/main` in
  `docs/validation/<VTID>/red-on-base.txt`, committed before the code: the done-rule tests (parked + `superseded_by`
  naming a done lane closes), the no-loosening tests (bare parked; naming a `ready`/`executing`/`in-review`/`verified`/
  `parked` lane, itself, a missing lane or a lane of another plan; a supersession chain through a parked lane), the
  compatibility test for `laneStates`, the `validateLane` tests for `superseded_by`, and the `validateRange` end-to-end
  fixture.
- [ ] Q2. `validateLane`: accept and check `superseded_by` (parked only, lane-id pattern, not itself, a sibling when
  `laneIds` is given).
- [ ] Q3. `transitionChain`: optional `lanes` list and the new close rule at `queue.mjs:390`; error names the blocking
  lanes and keeps the words `every lane`; `validateRange` passes `lanes` (with `laneStates`).
- [ ] Q4. `docs/validation/<VTID>/commands.log`: `node --test scripts/collab/*.test.mjs`; `node scripts/collab/queue.mjs
  validate --repo /projects/sandbox/vitana-platform --repo /projects/sandbox/vitana-v1`; dry run on a temporary copy of the
  real `mt-guardrails-r2` and `mt-track-s-r2` lane files showing the close allowed, and a plan with a bare parked lane
  still refused. Also `scope.json`, `acceptance.md` and `staging-tests.json` as the lane PR gate requires.
Acceptance:
- Change types: Tooling/docs (collab validator, protected gate file).
- Tests first and red on base: the new tests in `queue.test.mjs` fail on `origin/main` (log in `red-on-base.txt`) and
  pass on the head; the evidence is committed before the code.
- Done rule: a plan chain ending `done` passes when every lane is `done` or `parked` with `superseded_by` naming a `done`
  lane of the same plan; the three precedents (`s-j-retire-allowlist`, `local-test-stack`, `local-test-stack-v2`) pass
  once their `superseded_by` is written.
- No loosening: a parked lane without `superseded_by`, or with `superseded_by` naming a lane that is not `done`, itself,
  a missing lane or a lane of another plan, still blocks the close; `laneStates`-only callers behave as today; no
  existing assertion is changed or removed.
- Only `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs` and `docs/validation/<VTID>/` change; no lane or plan
  state of mt-track-s-r2, mt-guardrails-r2 or mt-track-s-authz is touched.
- Protected gate file: the merge needs the owner directive decision 3 (named plan) plus a reviewer-agent accept on the
  current head; the PR body says so.
- `node --test scripts/collab/*.test.mjs` green and `queue.mjs validate` clean on both checkouts.
