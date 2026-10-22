# VTID-05334 — acceptance (staging-verify-runner-fix / runner)

## Red → green
New test `existing suites may set only allowlisted, non-production env` in `scripts/ci/staging-verify/lib.test.cjs`:
- commit `5a232d889` (origin/main + the new test only), `node --test scripts/ci/staging-verify/lib.test.cjs`:
  `not ok 9 - existing suites may set only allowlisted, non-production env (staging-verify-runner-fix) # pass 61 # fail 1`
- this branch, same command: `# pass 62 # fail 0`
- this branch, `node --test scripts/ci/staging-verify/workflow.test.cjs`: `# pass 7 # fail 0` (run by no CI job — R2-F2
  builder note — so recorded here; it checks that `runExisting` passes no token and no `...process.env`).

## What changed
- `STAGING-VERIFY.yml` `verify`: `runs-on: ubuntu-24.04` (was `ubuntu-latest` = ubuntu-26.04, where Playwright
  1.51 cannot install Chromium — run 39757004449). `report` unchanged (R1-F3).
- `lib.cjs`: `existing` suites may carry `env`; only `APP_PROFILE` = `development` | `test-g1`. A non-object
  `env`, any other key (e.g. `GITHUB_TOKEN`, `NODE_OPTIONS`) or `production` is a manifest error. `existingEnv(t)`
  returns the validated object or `{}`.
- `run.mjs` `runExisting`: explicit env plus `lib.existingEnv(t)` only.

## Local proof for the consumer (lane `manifests`)
In vitana-v1 `apps/mobile` with the runner's minimal env: `npm run bundle` fails with "APP_PROFILE is not set" and
succeeds with `APP_PROFILE=development` ("Exported: dist").

## Not verified here
The pinned image is proven only by a STAGING-VERIFY run (plan §"How the fix is verified").
