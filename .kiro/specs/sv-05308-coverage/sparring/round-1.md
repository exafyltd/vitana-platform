# Sparring round 1 — in_progress

Session: `64ef89c6-29fe-44bb-b80c-93439416326f` · plan hash `b6b044ae4c8696a9f3247913ebccd2a77dbc7495a26f2d6244e03dafec20020f`

## Summary

The plan is well-scoped and its core premises hold. It correctly identifies the missing `staging-tests.json` as the sole cause of the STAGING-VERIFY failure and proposes the right fix. The loadManifest path, the validateManifest schema, the commit-coverage exclusion logic, the decideOutcome failure condition, and both referenced test files all check out against the pinned code. I found one minor omission in the manifest field specification and one minor line-reference inaccuracy — neither blocks implementation.

## Findings

### R1-F1 [minor]

The plan's field list for the manifest omits the required top-level `vtid` field. Section 3 says '(`service: gateway`)' and lists test-level keys (`kind`, `target`, `rejected_probe`, `expect_status`, `ref`, `cwd`, `reason`) but never states that the manifest must include `"vtid": "VTID-05308"`. `validateManifest` (lib.cjs line 214) checks `m.vtid !== vtid` and will reject a manifest missing this field.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:211` — function validateManifest(m, { vtid, service } = {}) {
    const errors = [];
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest is not a JSON object'] };
    if (vtid && m.vtid !== vtid) errors.push(`vtid is ${JSON.stringify(m.vtid)}, expected ${vtid}`);
    if (!SERVICES[m.service]) errors.push(`service must be one of ${Object.keys(SERVICES).join(', ')}`);
- `exafyltd/vitana-platform:docs/validation/VTID-04868/staging-tests.json:1` — {"vtid": "VTID-04868", "service": "gateway", "tests": [...]}

Suggestion: Explicitly state in §3 that the manifest top-level must include `"vtid": "VTID-05308"` alongside `"service": "gateway"` and `"tests": [...]`, matching the shape of existing manifests like VTID-04868's.

### R1-F2 [minor]

The plan cites `run.mjs:501` as the line that fails the STAGING-VERIFY run when a VTID has no staging-tests.json. Line 501 is actually inside the `checkPr` function (the PR pre-merge check), not the `verify` function. The `verify` flow's failure for missing manifests is determined by `planRange` placing the VTID in the `missing` array and `decideOutcome` (lib.cjs line 508) returning `'failed'` when `plan.missing.length > 0`.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:469` — function checkPr(args) {
    ...
    if (missing.length) {
      fail(`PR changes ${service} deploy paths but has no docs/validation/<VTID>/staging-tests.json for ${missing.join(', ')} ...`);
    }
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:505` — function decideOutcome({ superseded, results, plan }) {
    if (superseded) return results.some((r) => !r.ok && r.attributed === true) ? 'failed' : 'superseded';
    const failed = results.some((r) => !r.ok);
    if (failed || plan.missing.length > 0 || plan.invalid.length > 0) return 'failed';
    return 'passed';
  }

Suggestion: Correct the evidence paragraph: the STAGING-VERIFY verify flow fails via `lib.cjs:decideOutcome` (line 508) when `plan.missing.length > 0`, not via `run.mjs:501` (which is the `check-pr` path). The `loadManifest` reference at line 203 is correct.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
