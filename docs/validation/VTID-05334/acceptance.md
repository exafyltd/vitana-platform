# VTID-05334 — acceptance (staging-verify-runner-fix / runner)

## Red → green
New test `existing suites may set only allowlisted, non-production env` in `scripts/ci/staging-verify/lib.test.cjs`:
- origin/main + the new test only: `# pass 61 # fail 0 `
- this branch, `node --test scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/workflow.test.cjs`: `# pass 69 # fail 0 `
  (`workflow.test.cjs` is run by no CI job — R2-F2 builder note — so its local result is recorded here; it includes the
  check that `runExisting` passes no token and no `...process.env`.)

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
