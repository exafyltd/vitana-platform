# Sparring round 2 — converged

Session: `0f298442-dd81-4cd3-8d65-316b10905aaa` · plan hash `4ff3640c881eacb849ba4667a2b1e8dd825a690a29ec878cf6fc9d2c2cdf7df4`

## Summary

All three Round 1 findings were accepted and properly addressed. Two new minor findings remain: (1) the plan cites an incorrect line boundary for the AWS-STAGE-DEPLOY-FRONTEND.yml paths block (36-45 vs. actual 36-54), and (2) workflow.test.cjs — cited as evidence that env-isolation in runExisting is maintained — is not run by any CI gate (STAGING-TESTS-REQUIRED.yml:33 runs only lib.test.cjs; CI-SCRIPTS-TEST.yml covers an unrelated set of scripts). The core proof strategy, env-allowlist design, ordering mechanics, and manifest fixes are all sound.

## Findings

### R2-F1 [minor]

The plan states 'A vitana-v1 merge that only changes docs/** does not trigger AWS-STAGE-DEPLOY-FRONTEND.yml (paths, lines 36-45)'. The actual paths block in vitana-v1's AWS-STAGE-DEPLOY-FRONTEND.yml runs from line 36 to line 54: `src/**` through `bun.lock` occupy lines 37-44, `vite.config.ts` is line 53, and `.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml` is line 54. Line 45 is `bun.lock`; the block has not ended there. The substance is correct — `docs/**` is absent from all 54 lines — but the cited boundary (line 45) cuts off before the block ends, and anyone using the line number to audit the trigger during implementation will find two entries (vite.config.ts, the workflow file) that the cited range omits.

- `exafyltd/vitana-v1:.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml:33` — on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'public/**'
      - 'index.html'
      - 'Dockerfile'
      - 'nginx.conf'
      - 'package.json'
      - 'package-lock.json'
      - 'bun.lock'
      ...
      - 'vite.config.ts'
      - '.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml'

Suggestion: Update the plan's reference to 'paths, lines 36-54' (or simply 'the paths: block'). Alternatively, name the entries explicitly: 'src/**, public/**, index.html, Dockerfile, nginx.conf, package.json, package-lock.json, bun.lock, vite.config.ts, .github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml — no docs/** entry.'

### R2-F2 [minor]

The plan says 'workflow.test.cjs:73-76 keeps passing' and uses this as evidence that the new ...lib.existingEnv(t) spread in runExisting does not leak process.env or secrets. But workflow.test.cjs is not run by any CI gate: STAGING-TESTS-REQUIRED.yml (vitana-platform) line 33 runs only lib.test.cjs; CI-SCRIPTS-TEST.yml covers test-suite, plan-spar-slot and plan-driver scripts and does not include staging-verify scripts. The isolation guarantee is therefore manual-verification-only, with no automated enforcement. This is a pre-existing gap, but this plan is the first to add a new env-injection path to runExisting (lib.existingEnv spread), making the gap newly relevant. Analysis confirms the planned code — env: { PATH, HOME, CI:'1', NODE_ENV:'test', ...lib.existingEnv(t) } — does not match the regex /GITHUB_TOKEN|VITANA_V1_READ_TOKEN|\.\.\.process\.env\b/, so the test would still pass; the issue is purely that CI will never run it.

- `exafyltd/vitana-platform:.github/workflows/STAGING-TESTS-REQUIRED.yml:32` — - name: Runner unit tests
  run: node --test scripts/ci/staging-verify/lib.test.cjs
- name: VTID auto-close unit tests (VTID-04691)
  run: node --test scripts/ci/staging-verify/workflow.test.cjs
- `exafyltd/vitana-platform:.github/workflows/CI-SCRIPTS-TEST.yml:49` — - name: Run tests
  run: |
    node --test scripts/ci/test-suite/*.test.mjs scripts/ci/plan-spar-slot/*.test.mjs scripts/collab/plan-driver.test.mjs
- `exafyltd/vitana-platform:scripts/ci/staging-verify/workflow.test.cjs:72` — // runPlaywright / runExisting build an explicit env; neither passes these tokens.
for (const fn of ['function runPlaywright', 'function runExisting']) {
  const body = src.slice(src.indexOf(fn), src.indexOf('\n}\n', src.indexOf(fn)));
  assert.doesNotMatch(body, /GITHUB_TOKEN|VITANA_V1_READ_TOKEN|\.\.\.process\.env\b/, fn);
}

Suggestion: Add workflow.test.cjs to the STAGING-TESTS-REQUIRED.yml runner-tests step: change line 33 to `node --test scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/workflow.test.cjs`. This is a one-line change in the runner lane and closes the gap before the env-injection capability ships.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Rationale is sound. The plan correctly drops the re-run of 39757004449 and replaces it with the first STAGING-VERIFY run on a vitana-v1 main commit that includes both lanes and 3d144939, triggered by the next natural deploy (push touches src/** etc.) or owner workflow_dispatch after a 4 h timeout. The checkout-at-SHA mechanics (STAGING-VERIFY.yml:164-172, run.mjs:374) are correctly described. The proof strategy is valid.
- R1-F2: acknowledged — Rationale is sound. Two guards are in place: (1) the new validator in lib.cjs rejects non-object env, unknown keys, and disallowed values, with lib.test.cjs cases written red-on-main; (2) the ordering is mechanical via §7b and the M3 recorded check that existingEnv is exported before the manifests lane merges. The old validator silently accepts env (lines 169-181 have no unknown-field check), so the gap is correctly closed by ordering rather than retroactive code change.
- R1-F3: acknowledged — Rationale is sound. The plan correctly pins only the verify job (which calls npx playwright install chromium) to ubuntu-24.04 and leaves the report job on ubuntu-latest. The report job contains no Playwright invocation as confirmed by STAGING-VERIFY.yml:224-228.
