# Sparring round 1 — in_progress

Session: `1dfb8561-65af-4685-9728-818f9a29e955` · plan hash `6d5ea915e84f4d5532f67cde85078efb483278bea1b2826a3e321bf70d636060`

## Summary

The plan is well-scoped and the core premises hold. Adding `docs/validation/commit-coverage.json` to vitana-v1 with 10 entries mapping VTID-less merge commits to their lane VTIDs is the correct mechanism per `lib.cjs:parseCommitCoverage` / `planRange`. All 10 covering staging-tests.json manifests exist and are structurally valid. One minor concern about whether 3 of the 10 merge commits actually need coverage entries given their listed file changes don't match community-app deploy paths.

## Findings

### R1-F1 [minor]

Premise 5 states batches 3, 4, and 5 only change `scripts/ci/pr-gate/baseline/design.json` / `eslint.json`. These paths do not match any community-app `deployPaths` pattern (which requires `src/**`, `public/**`, `package.json`, etc.). The `touchesService` function at lib.cjs:102-106 would therefore return false for those 3 merge commits, and `planRange` (lib.cjs:303) would skip them — they would never appear in the `missing` list. Adding coverage entries for commits that don't touch the service is harmless but unnecessary, and it raises a question about whether the plan's report of '10 commits under Missing change suite' is accurate, or whether the actual diff of those merges includes `src/` files not listed in premise 5.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:46` — 'community-app': { repo: 'exafyltd/vitana-v1', target: 'frontend', ... deployPaths: ['src/**', 'public/**', 'index.html', 'Dockerfile', 'nginx.conf', 'package.json', 'package-lock.json', 'bun.lock', 'vite.config.ts', '.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml'] }
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:102` — function touchesService(files, service) {
    const cfg = SERVICES[service];
    if (!cfg) throw new Error(`unknown service ${service}`);
    return files.some((f) => cfg.deployPaths.some((p) => pathMatches(f, p)));
  }
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:302` — for (const c of commits) {
      if (!touchesService(c.files || [], service)) continue;

Suggestion: Clarify in premise 5 whether batches 3/4/5 merges also touch files under `src/` (e.g. design token files). If they genuinely only touch `scripts/ci/`, they will never be in `missing` and their coverage entries are dead weight — remove them to keep the file honest. If they do touch `src/`, update premise 5 to list those files.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
