---
change_class: standard
---
# Plan — staging-verify-runner-fix

Author: Kiro, session `kiro-exafyltd-202610220818-5273` (seat `exafyltd`). Repos: `exafyltd/vitana-platform`
(STAGING-VERIFY workflow + runner) and `exafyltd/vitana-v1` (two change-suite manifests). No product code, no
migration, no live write. `handoff.md` declares the `exafyltd/vitana-v1: main` spar ref.

<!-- plan:begin -->
## Goal
Owner, 2026-10-22 (Kiro Web), after STAGING-VERIFY failed on the profile Posts fix (VTID-05330, vitana-v1
`3d144939`): *"ok, let's fix the verification first"*. Goal: STAGING-VERIFY for `community-app` can pass on a healthy
staging build, so Gate 2 can be sent. Nothing is loosened: every suite that ran before still runs, and the ones that
never really ran start running.

## Measured state
Run https://github.com/exafyltd/vitana-platform/actions/runs/39757004449 (community-app @ `3d144939`), 18/25 passed.
The 7 failures have three causes, none in product code:
1. **Runner image.** `.github/workflows/STAGING-VERIFY.yml:89` (`verify`) uses `runs-on: ubuntu-latest`, which GitHub now resolves to `ubuntu-26.04` (log: "Image: ubuntu-26.04"). The runner
   (`scripts/ci/staging-verify/run.mjs:255`) runs `npx playwright install chromium --with-deps` with Playwright
   1.51.0, which fails: *"Playwright does not support chromium on ubuntu26.04-x64"*. So both smoke Playwright tests and
   every `playwright` change suite (here VTID-05330's) fail before they start. 3 failures.
2. **Generated file not built.** vitana-v1 `docs/validation/VTID-05298/staging-tests.json:6` runs `npx jest tests/news`
   in `apps/mobile`. jest is called directly, so `apps/mobile/package.json` `pretest` (`npm run gen:i18n`) never runs
   and the suite dies with *"Cannot find module './catalog-map.generated' from 'src/i18n/index.ts'"*. 1 failure.
3. **Wrong config path.** vitana-v1 `docs/validation/VTID-05296/staging-tests.json:8` runs
   `npx jest tests/community --config apps/mobile/jest.config.js` with `cwd: apps/mobile`, so the config path resolves
   to `apps/mobile/apps/mobile/jest.config.js` (*"Can't find a root directory…"*). 1 failure.
4. **Missing build profile.** Both manifests run `npm run bundle` (`expo export`), and `apps/mobile/app.config.ts:34`
   throws unless `APP_PROFILE` is set. NATIVE-CI sets `APP_PROFILE: development` (`NATIVE-CI.yml:117`), but
   `runExisting` (`run.mjs:310`) passes only `PATH, HOME, CI, NODE_ENV`. 2 failures.

Constraints from the runner: `existing` refs are split on spaces and spawned without a shell (`run.mjs:304-306`), and
`lib.cjs:123` `EXISTING_REF` allows only `npm run <script>`, `npx jest <paths>` or `npx vitest run <paths>`. So
`npm run test -- tests/news` and `APP_PROFILE=… npm run bundle` are not valid refs today.

## Changes
### Lane `runner` (vitana-platform)
1. `STAGING-VERIFY.yml` `verify` only: `runs-on: ubuntu-24.04` (pinned, a Playwright 1.51 supported image), with a
   comment naming this failure (R1-F3). `report` runs no browser and stays `ubuntu-latest`. No other workflow change.
2. Optional per-test `env` for `existing` suites, closed by an allowlist:
   - `lib.cjs` `validateTest` `existing`: `env` is optional. If present and not a plain object (null, array,
     string), it is a manifest error (R1-F2). Otherwise it must be an object whose keys are in
     `EXISTING_ENV_ALLOW = { APP_PROFILE: /^(development|test-g1)$/ }`. Any other key, or any other value (including
     `production`), is a manifest error. Export `existingEnv(t)`, which returns the validated object or `{}`.
   - `run.mjs` `runExisting`: env = `{ PATH, HOME, CI: '1', NODE_ENV: 'test', ...lib.existingEnv(t) }`. No secret and
     no `process.env` spread. `workflow.test.cjs:73-76` keeps passing.
3. Tests in `lib.test.cjs` (run by vitana-platform `.github/workflows/STAGING-TESTS-REQUIRED.yml:33`): `APP_PROFILE:
   development` accepted; `APP_PROFILE: production`, an unknown key (`GITHUB_TOKEN`), and a non-object `env` all
   rejected; `existingEnv` returns `{}` without `env`. Written first and red on main.
### Lane `manifests` (vitana-v1, `depends_on: [runner]`)
4. `VTID-05298/staging-tests.json`: insert an `existing` entry `npm run gen:i18n` (cwd `apps/mobile`) **before**
   `npx jest tests/news`, which stays unchanged. Valid under today's `EXISTING_REF`, no new package script; the runner
   runs a manifest's entries in order (`run.mjs` `runSuite`, `for (const [i, t] of tests.entries())`).
5. `VTID-05296/staging-tests.json`: `npx jest tests/community --config apps/mobile/jest.config.js` →
   `npx jest tests/community` (the default config in `apps/mobile` is that file), preceded by `npm run gen:i18n`.
6. Both manifests: the `npm run bundle` entry gets `"env": { "APP_PROFILE": "development" }`, the profile NATIVE-CI
   uses. It never builds a production profile (`app.config.ts:37` refuses one).

## Order and parallelism
`runner` first, then `manifests` (`depends_on: [runner]`). The ordering is mechanical, not prose (R1-F2): the §7b
merge rule merges a lane only when every `depends_on` lane is `done`, and lane `manifests`' acceptance requires
`existingEnv` to be exported by vitana-platform `main`'s `lib.cjs` (checked with `node -e` in the lane, recorded in its
PR) before it merges. No shared files between lanes. Hot files: none.

**How the fix is verified (R1-F1).** STAGING-VERIFY checks out vitana-v1 at the commit under test
(`STAGING-VERIFY.yml:164-172`) and reads its manifests there (`run.mjs:374`), so a re-run of the old run 39757004449
(at `3d144939`) cannot see the manifest fixes, and is not used. A vitana-v1 merge that only changes `docs/**` does not
trigger `AWS-STAGE-DEPLOY-FRONTEND.yml` (`paths`, lines 36-45), and agents do not dispatch workflows (§7a). So the
proof is the **first STAGING-VERIFY community-app run on a vitana-v1 `main` commit that contains both lanes and
`3d144939`**, started by the next staging deploy of any app change (deploys run several times a day: 10:12 and 09:30
today). Its change suites include VTID-05330, VTID-05298 and VTID-05296 read from that head. If no app change deploys
within 4 h of the last lane merge, the driver asks the owner (one five-part message) to run STAGING-VERIFY
`workflow_dispatch` with `service: community-app` and `commit_sha` = vitana-v1 `main`; the driver never dispatches it.

## Tests and evidence
- `node --test scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/workflow.test.cjs` green; the new
  cases red on main.
- `lib.validateManifest` run on both edited manifests (in the `manifests` lane) → `ok: true`.
- Proof of run: the STAGING-VERIFY run defined above (a vitana-v1 `main` commit after both lanes) shows the Playwright smoke, VTID-05330's spec and the native
  suites executing (pass or a real failure), not failing at install or setup.

## Risks
- Once Chromium installs, specs that never ran will run, and a real failure may show up (the smoke tests, VTID-05330).
  That is the point. A real failure is fixed forward as its own lane, never skipped.
- `ubuntu-24.04` reaches end of support later. The pin is explicit and commented, so a future Playwright upgrade can
  lift it.
- The env allowlist is one key with two values; widening it is a reviewed change to `lib.cjs`.

## Unchanged
Gateway STAGING-VERIFY (its failure on run 39749935077 has a different cause, out of scope), PR-GATE `preview-e2e`
(report-only; `PR-GATE.yml` is a protected gate file), product code, production workflows, every other manifest.
<!-- plan:end -->
