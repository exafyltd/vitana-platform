# Sparring round 1 — in_progress

Session: `e943ed9f-35f0-45c6-a364-c474e301c45a` · plan hash `cbd1f5fe536acd0a96fbeb299ce88e20f6fb5933e2b3e1f56459fb04c5f9d1f2`

## Summary

The plan is well-researched and every core premise I checked holds against the pinned code. The EXISTING_REF regex, manifest contents, index.html script tags, project-manager route shape, deleted test file references, protected-gate-files list, and STAGING-TESTS-REQUIRED workflow all match the plan's claims. I found one minor gap in the declared file scope for a lane, and one minor concern about silent-pass risk for typo'd `expect_json_in` keys. No blockers or major issues identified.

## Findings

### R1-F1 [minor]

The §4 test command for lane `pm-mode-probes` references `scripts/ci/staging-verify/workflow.test.cjs`, but that file is not listed in the lane's exact files (`lib.cjs`, `lib.test.cjs`, plus two manifests). If the file does not already exist, the command will fail. If it does exist but the lane adds new cases to it, it must be in the exact files list. Either the command is wrong (should reference only `lib.test.cjs`) or the exact files list is incomplete.

- `exafyltd/vitana-platform:.github/workflows/STAGING-TESTS-REQUIRED.yml:38` — - name: Runner unit tests
          run: node --test scripts/ci/staging-verify/lib.test.cjs

Suggestion: Clarify whether `workflow.test.cjs` already exists (and is just being run, not modified) or needs to be created/modified by this lane. If it is modified, add it to the lane's exact files. If the new `expect_json_in` test cases are only in `lib.test.cjs`, drop `workflow.test.cjs` from the §4 command.

### R1-F2 [minor]

The new `expect_json_in` runner key is validated when present, but `validateHttpTest` does not reject unknown keys. A manifest author who typos the key name (e.g. `expect_json_inn`) will see the key silently ignored and the probe will pass without checking the constraint. This is a pre-existing design gap for `expect_json` and `expect_body_contains` too, but since the plan is adding a new key it is worth noting.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:149` — function validateHttpTest(t, where) {
    const errors = [];
    const method = String(t.method || 'GET').toUpperCase();
    if (typeof t.path !== 'string' || !t.path.startsWith('/')) {
      errors.push(`${where}: path must start with "/"`);
    }
    if (t.target && !['gateway', 'frontend'].includes(t.target)) {
      errors.push(`${where}: target must be "gateway" or "frontend"`);
    }
    if (t.expect_status !== undefined && !Number.isInteger(t.expect_status)) {
      errors.push(`${where}: expect_status must be an integer`);
    }
    if (READ_METHODS.has(method)) return errors;
    ...

Suggestion: Consider adding a known-keys allowlist check to `validateHttpTest` (or at least to the `drift-guard` test) so that any unrecognised key in an http probe is flagged. This would catch typos for all keys, not just `expect_json_in`.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
