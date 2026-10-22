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
