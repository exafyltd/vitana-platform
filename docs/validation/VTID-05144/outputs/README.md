# VTID-05144 — outputs

Local evidence (no staging, no production, no workflow dispatch):

- `node-test-head.txt` — `node --test` of lib.test.cjs, record-oasis.test.cjs,
  workflow.test.cjs and confirm-live.test.mjs on this branch: 77/77 pass.
- `node-test-new-tests-on-base-code.txt` — the same four test files run against
  the origin/main runner, lib, record-oasis.sh and STAGING-VERIFY.yml: 19 fail
  (every new VTID-05144 case; confirm-live.test.mjs cannot import a
  `confirmLive` export on base), 53 pass (all pre-existing cases). Red → green.
- `jest-head.txt` — gateway Jest: publish-gate, operator-runs-view,
  operator-runs, vtid-05069 pipeline tree, vtid-04715 workflow, vtid-04868
  skill: 6 suites / 100 tests pass.
- `tsc-noemit.txt` — `npx tsc --noEmit -p .` in services/gateway: 3 errors, all
  TS2307 "Cannot find module" for `libphonenumber-js` and
  `@aws-sdk/client-pinpoint-sms-voice-v2` in files this change does not touch;
  the local node_modules predates those dependencies (CI runs `npm ci`). No
  error in publish-gate.ts or run-view.ts.
- `pr-gate.txt` — `scripts/ci/pr-gate/gate.mjs` scope / sparring / weakening /
  red-green against origin/main.

## Staging evidence (AC-12)

### 1. Full run superseded by a redeploy mid-run → chained full run

- Run: https://github.com/exafyltd/vitana-platform/actions/runs/38429381084
  (`workflow_dispatch`, gateway, `full=true`, `commit_sha=f7263f19b081`,
  dispatched 2026-10-13T16:18Z; staging redeployed during the run).
- Result: outcome `superseded`, 1114 tests, 1111 passed. Staging moved from
  `f7263f19b081` to `e7a4c90fb561` (a descendant). Attribution cutoff
  2026-10-13T16:24:28.602Z: the run start, because the staging deploy began
  before it. All 1114 results are therefore unattributed (0 attributed
  passed, 0 attributed failed). The 3 failures that happened while staging
  redeployed did not fail the run. Before VTID-05144 the same run ended as
  `mismatch` / failed.
- OASIS (read-only query, AC-12 / OASIS_PROOF): event
  `180e0ab5-4f3d-4337-94f4-3a47eec94d76`, 2026-10-13 17:06:27Z, topic
  `staging.verify.superseded`, `metadata.commit=f7263f19b081…`,
  `metadata.superseded_by=e7a4c90fb56197ca256bf3343f3a980fd52b5765`,
  `metadata.attribution_cutoff=2026-10-13T16:24:28.602Z`, `metadata.chain=0`,
  `metadata.full=true`.
- Report job: step "Re-run the full verification on the newer commit
  (VTID-05144)" succeeded and dispatched the chained full run
  https://github.com/exafyltd/vitana-platform/actions/runs/38436837467
  (gateway @ `e7a4c90fb561`, chain=1).

- Chained run 38436837467 (chain=1, gateway @ `e7a4c90fb561`) was itself
  superseded when the #4095 merge redeployed staging to `fdf6af3e921b`:
  1126/1127 passed, cutoff 2026-10-13T17:30:27.790Z, all 1127 results
  unattributed, `metadata.chain=1`. It dispatched the next chained full run
  https://github.com/exafyltd/vitana-platform/actions/runs/38444220325
  (gateway @ `fdf6af3e921b`, chain=2). Two supersedes in a row, each
  re-dispatching once, as designed (cap: chain < 3).

- Chained run 38444220325 (chain=2, gateway @ `fdf6af3e921b`) was superseded
  when staging moved to `c338571707dc`: 1126/1127 passed, cutoff
  2026-10-13T18:13:02.711Z, all unattributed, `metadata.chain=2`. It dispatched
  https://github.com/exafyltd/vitana-platform/actions/runs/38450928100
  (gateway @ `c338571707dc`, chain=3).
- Chained run 38450928100 (chain=3) was superseded when staging moved to
  `1eb58a3837f5`: 1130/1133 passed, cutoff 2026-10-13T19:04:25.000Z,
  **114 attributed results, 0 attributed failures**, 1019 unattributed.
  This is the first after-run supersede with a non-empty attributed set. The
  3 failures (VTID-04880, VTID-05057 ×2) ended after the cutoff and did not
  fail the run. With chain=3 the report job does not dispatch again (cap
  `chain < 3`).

### 2. Full run that passes (`staging.verify.passed`, `metadata.full=true`)

- Not yet: on 2026-10-13 staging redeployed about every 30 min during the day,
  faster than a full run (~45 min). Fresh full runs were dispatched at
  19:35Z (gateway @ `b3a5aca84be2`, community-app @ `60f0f06ec6aa`). The
  first full run that ends `passed` or `failed` (this one or the nightly)
  is recorded here.
