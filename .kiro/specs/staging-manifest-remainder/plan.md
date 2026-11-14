---
change_class: standard
---
# plan(staging-manifest-remainder): repair the four manifests that the drift guard reports

Author: Kiro, seat `exafy`. Repo: `exafyltd/vitana-platform`. Premises pinned to `origin/main` `40a053e6a4` (MR !8 merge
on GitLab; GitHub main at the time of drafting: `631b8260b9`, the ref-05331 merge). Every file:line below was read on that tree.

<!-- plan:begin -->
## 1. Goal
Owner task (2026-11-11): the four manifest changes that were left in PR #4964 go into their own lanes. Done when
the drift guard (`scripts/ci/staging-verify/manifest-drift.test.cjs`, PR #4993) reports no finding on `main`, and the four
manifests run the same probes they did before, or a stronger one. No probe is removed without evidence.

## 2. Today (evidence)
1. **VTID-05504 has no tests.** `docs/validation/VTID-05504/staging-tests.json` has `"tests": []` (line 6) and a
   `not_verified_on_staging` text. The guard reports `tests must be a non-empty array`. The lane's real check is a jest
   suite that moves with it: `docs/validation/VTID-05504/morning-health-pertenant.test.ts` moves to
   `services/gateway/test/vtid-05504-morning-health-pertenant.test.ts` (PR #4964 rename, 98% similar; its doc comment
   changes its `Run:` line to `cd services/gateway && npx jest test/vtid-05504-morning-health-pertenant.test.ts`).
   The manifest gets one `existing` entry with that ref and `cwd: services/gateway`.
2. **VTID-05506 and VTID-05507 use a ref the validator rejects.** Both have
   `"ref": "node --test scripts/ci/check-migration-drift.test.cjs"` (`tests[0]`). `EXISTING_REF`
   (`scripts/ci/staging-verify/lib.cjs:123`) accepts `npm run <script>`, `npx jest` and `npx vitest run` only, so
   `validateManifest` returns `ok:false`. The fix is one root script `test:migration-drift` in `package.json`
   (`node --test scripts/ci/check-migration-drift.test.cjs`, same runner, same file) and `"ref": "npm run test:migration-drift"`.
   The root `package.json` has no `test:migration-drift` today (checked: 0 matches on `origin/main`).
3. **VTID-05609 has no tests.** `docs/validation/VTID-05609/staging-tests.json` has `"tests": []` (line 5) and
   `not_verified_on_staging: true`. Its covering check is `docs/validation/VTID-05609/outputs/queue-check.mjs` plus
   preflight. Adding one `/alive` probe, the same shape every other docs-only manifest uses, makes the guard green
   without claiming the docs check is a staging test. The `not_verified_on_staging` text stays.
4. **Why it matters:** these four are the only findings of the guard on `main`, so `drift-guard` (VTID-05602) can merge
   only after this plan lands.

## 3. Lanes
- `remainder-05504`: `docs/validation/VTID-05504/staging-tests.json`, `docs/validation/VTID-05504/morning-health-pertenant.test.ts`
  (deleted), `services/gateway/test/vtid-05504-morning-health-pertenant.test.ts` (new), `docs/validation/VTID-05504/**`.
- `remainder-migration-scripts`: `package.json` (one script), `docs/validation/VTID-05506/staging-tests.json`,
  `docs/validation/VTID-05507/staging-tests.json`.
- `remainder-05609`: `docs/validation/VTID-05609/staging-tests.json` only.

The three lanes touch disjoint files, so they run in parallel. None of them changes a protected gate file. The
`package.json` lane is a root script only; root `package.json` is outside the gateway deploy paths (lib.cjs:41-44).

## 4. Tests and commands
- Red on `main` first, recorded in each lane's `outputs/`: `node --test scripts/ci/staging-verify/manifest-drift.test.cjs`
  reports one finding per manifest (check 1 for 05504, 05506, 05507, 05609).
- Green on the head: the same guard passes 6 of 6 checks; `node --test scripts/ci/check-migration-drift.test.cjs` still
  passes (the test is unchanged, only its runner changes).
- `cd services/gateway && npx jest test/vtid-05504-morning-health-pertenant.test.ts` (jest, ts-jest preset from services/gateway/jest.config.js).

## 5. Measurement
Lane timings in each lane's log, as in the other plans.

## 6. Risks
- The 05504 suite is a jest test under `services/gateway/test`: moving it puts it in the gateway test run, so the lane
  must show that the gateway jest run still passes with it. The suite uses a stubbed curl and no network.
- `package.json` edits affect every root script; the lane changes only one line and leaves the others alone.

## 7. Unchanged
No probe is removed. No product code changes. No migration. No production write. No change to MR !2.
<!-- plan:end -->
