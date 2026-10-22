# Plan sparring record — staging-verify-runner-fix (VTID-05334 runner, VTID-05333 manifests)

- Partner: CI PLAN-SPAR (vitana-platform `PLAN-SPAR.yml`), session `0f298442-dd81-4cd3-8d65-316b10905aaa`.
- Class: standard
- Plan hash (sha256 of the text between the plan markers, final): 4ff3640c881eacb849ba4667a2b1e8dd825a690a29ec878cf6fc9d2c2cdf7df4
- Verdict: **CONVERGED** (round 2; R1-F1 blocker, R1-F2 major, R1-F3 minor — all ACCEPTED; R2-F1/F2 minor, builder notes).
- Owner approval (Gate 1): not asked — policy approval `converged-auto-v1` at 2026-10-22T11:07:50Z replaces Gate 1 for a
  CI-sparred plan. Owner instruction in the Kiro Web chat 2026-10-22: "ok, let's fix the verification first".
- VTIDs: VTID-05334 (lane `runner`), VTID-05333 (lane `manifests`), allocated by CI PLAN-SPAR.
- Spec: `.kiro/specs/staging-verify-runner-fix/` (plan PR #4309, merged 84ad1a885740f639feee5d695b834d6216b27782).

## Round 1 (verbatim)

# Sparring round 1 — in_progress

Session: `0f298442-dd81-4cd3-8d65-316b10905aaa` · plan hash `984305ed88e7121fbfb305ecbac452ec9a55cd0cecaa7f0360f51b3b80c3713d`

## Summary

The plan correctly identifies all four root causes and the individual fixes are technically sound. However, the delivery mechanism—re-running the old STAGING-VERIFY run 39757004449—contains a fatal flaw: GitHub re-runs check out vitana-v1 at the original SHA (`3d144939`), so the manifests-lane fixes are invisible to the re-run. Only the runner-lane fix (platform checkout always uses `ref: main`) will be picked up. The four manifest failures will survive the re-run unchanged. One other gap: the existing-suite `env` field is silently accepted by the current validator, creating a latent risk if lane ordering slips.

## Findings

### R1-F1 [blocker]

Re-running STAGING-VERIFY run 39757004449 will NOT pick up the manifests-lane fixes. STAGING-VERIFY.yml lines 164-172 check out vitana-v1 at `ref: ${{ env.SHA }}`, where SHA is resolved once from the original trigger event and is always `3d144939`. That checkout is what `loadManifest` reads (run.mjs line 374: `manifests[v] = loadManifest(repoRoot, v)`). The manifest fixes—inserting the `npm run gen:i18n` entry, removing the double `--config` path, and adding the `env: {APP_PROFILE}` block—live only in new commits on vitana-v1 main that post-date `3d144939`. Only the runner-lane fix is picked up by a re-run, because the runner checkout (lines 149-154) uses `ref: main` unconditionally. The plan's assertion 'That run verifies the same deployed commit with the fixed runner **and manifests**' is false for all four manifest-related failures.

- `exafyltd/vitana-platform:.github/workflows/STAGING-VERIFY.yml:147` — # The runner always comes from vitana-platform main — the version that
# passed review — never from the commit under test.
- name: Checkout runner (vitana-platform main)
  uses: actions/checkout@v4
  with:
    ref: main
    path: runner
    sparse-checkout: scripts/ci/staging-verify
...
- name: Checkout commit under test (community-app)
  uses: actions/checkout@v4
  with:
    repository: exafyltd/vitana-v1
    ref: ${{ env.SHA }}
    path: target
    fetch-depth: 0
- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:373` — const manifests = {};
for (const c of commits) for (const v of lib.extractVtids(c.subject)) if (!(v in manifests)) manifests[v] = loadManifest(repoRoot, v);
- `exafyltd/vitana-v1:docs/validation/VTID-05298/staging-tests.json:5` — { "kind": "existing", "ref": "npx jest tests/news", "cwd": "apps/mobile", ... }
- `exafyltd/vitana-v1:docs/validation/VTID-05296/staging-tests.json:8` — { "kind": "existing", "ref": "npx jest tests/community --config apps/mobile/jest.config.js", "cwd": "apps/mobile", ... }

Suggestion: A re-run of the old run is not a valid delivery vehicle for the manifests-lane changes. Three alternatives: (a) After the runner lane and manifests lane are both on their respective mains, manually dispatch STAGING-VERIFY via `workflow_dispatch` pointing at a new vitana-v1 commit that includes both the app change (`3d144939` ancestry) and the manifest fixes—i.e., a new tip of vitana-v1 main. (b) Combine the manifests fixes into a commit that also touches a deploy-path file (so AWS-STAGE-DEPLOY-FRONTEND triggers and STAGING-VERIFY fires automatically for the new commit). (c) Document that the runner-lane re-run only proves Playwright install is fixed, and treat the manifests-lane as requiring a separate verification dispatch. Whichever approach is chosen, the plan must not call the re-run of 39757004449 proof of manifest correctness.

### R1-F2 [major]

The current `validateTest` for `existing` suites (lib.cjs lines 169-181) silently ignores any extra fields, including `env`. If the manifests lane is merged to vitana-v1 before the runner lane ships the new lib.cjs validator, the `env: {APP_PROFILE: development}` entries will be accepted by the old validator without error (no field is rejected as unknown), yet `runExisting` (run.mjs line 310) will not read `t.env` and will not pass `APP_PROFILE`. The bundle steps will silently continue to fail with the same 'APP_PROFILE is not set' error, and there will be no CI signal that the ordering invariant was broken. The plan's `depends_on: [runner]` is a prose constraint only—no CI gate in either repo mechanically enforces it.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:169` — case 'existing': {
  const errors = [];
  if (typeof t.ref !== 'string' || !EXISTING_REF.test(t.ref)) {
    errors.push(`${where}: ref must be...`);
  }
  if (t.cwd !== undefined && ...) {
    errors.push(...);
  }
  if (typeof t.reason !== 'string' || t.reason.trim().length < 10) {
    errors.push(...);
  }
  return errors;
}
- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:300` — function runExisting(repoRoot, t) {
  ...
  const r = spawnSync(bin, argv, {
    cwd: cwdAbs,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', NODE_ENV: 'test' },
  });
- `exafyltd/vitana-v1:docs/validation/VTID-05298/staging-tests.json:10` — { "kind": "existing", "ref": "npm run bundle", "cwd": "apps/mobile",
  "reason": "...run with APP_PROFILE=development" }

Suggestion: Add a guard to `validateTest`'s `existing` branch in lib.cjs that rejects an `env` key whose value is not an object: `if ('env' in t && (typeof t.env !== 'object' || t.env === null || Array.isArray(t.env))) errors.push(...)`. This produces a hard validation error rather than silent acceptance when the manifests are opened before the runner ships. The plan already adds the allowlist check for known keys; coupling it with a type-check here closes the silent-failure window regardless of lane ordering.

### R1-F3 [minor]

The plan states both the `verify` job (line 89) and the `report` job (line 227) 'use runs-on: ubuntu-latest … which fails: Playwright does not support chromium on ubuntu26.04-x64.' The `report` job contains no Playwright invocation—it only posts commit statuses and PR comments. Attributing the Playwright install failure to the `report` job is inaccurate, and pinning `report` to ubuntu-24.04 with the comment 'a Playwright 1.51 supported image' is misleading.

- `exafyltd/vitana-platform:.github/workflows/STAGING-VERIFY.yml:224` — report:
  needs: verify
  if: always() && needs.verify.outputs.sha != ''
  runs-on: ubuntu-latest
  timeout-minutes: 5
- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:254` — if (!browsersInstalled && !(process.env.STAGING_VERIFY_SKIP_BROWSER_INSTALL ?? '')) {
  execFileSync('npx', ['playwright', 'install', 'chromium', '--with-deps'], { cwd: cwdAbs, stdio: 'inherit' });
  browsersInstalled = true;
}

Suggestion: Pin `report` to ubuntu-24.04 if desired for consistency, but use a comment like 'pinned to match verify job (consistency/maintenance)' rather than citing Playwright support. Alternatively leave `report` on ubuntu-latest—it has no dependency on a specific Ubuntu version and the pin adds future maintenance burden for no functional benefit.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

## Responses 1 (verbatim)

# Responses — round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct: STAGING-VERIFY.yml:164-172 checks out vitana-v1 at the commit under test and run.mjs:374 reads manifests there, so a re-run at 3d144939 cannot see the manifest fixes. The re-run is dropped. Proof is now the first STAGING-VERIFY community-app run on a vitana-v1 main commit that contains both lanes and 3d144939, triggered by the next app deploy (alternative (b)'s effect without coupling an unrelated app change; deploys run several times a day). Agents may not dispatch workflows (collaboration.md §7a), so alternative (a) becomes an owner stop after 4 h without a deploy: the driver asks the owner to run workflow_dispatch with commit_sha = vitana-v1 main. The 'fixed runner and manifests' claim about the old run is removed."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Two guards. (1) The new validator rejects a non-object env (null, array, string) as well as unknown keys and disallowed values; tests cover all three. (2) The ordering is made mechanical: manifests depends_on runner, the §7b rule merges only when every depends_on lane is done, and the manifests lane's acceptance (tasks.md M3) requires a recorded check that vitana-platform main's lib.cjs exports existingEnv before merge. The old validator cannot be changed retroactively, so the gap is closed by ordering, not by the old code."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Correct: report (STAGING-VERIFY.yml:224) runs no browser. Only verify is pinned; report stays ubuntu-latest. Measured-state item 1 and tasks R4 corrected."
  }
]
```

## Round 2 (verbatim)

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
