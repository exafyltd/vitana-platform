# Sparring round 1 — in_progress

Session: `b4e152cf-2aff-43f8-a1a3-3c5956b9825d` · plan hash `c46cd3d81337a868569ccc88ce6e314342dafde04d0c8c13f3f363b2c949e2ca`

## Summary

The platform-side premises are well-supported: ENFORCE has no dependency cache, PHASE-2B has an unnecessary fetch-depth: 0, the kebab-case step forks multiple subprocesses per file, and UNIT.yml discovers all scripts/**/*.test.mjs files. The proposed changes to ENFORCE (npm cache + --no-audit --no-fund) and PHASE-2B (shallow checkout, one-pass awk) are safe and well-guarded by an oracle test.

The plan's largest change (v1-vitest-shards) cannot be verified because vitana-v1 has no pinned ref in this review session. The plan also departs from the proven platform shard-union pattern (which cross-validates the test list across all shards) by uploading the list from only shard 1.

## Findings

### R1-F1 [major]

The entire v1-vitest-shards lane (§4.1) depends on premises about vitana-v1/.github/workflows/UNIT-TESTS.yml (job name 'Vitest (jsdom)', job structure, npm ci install, concurrency, triggers, 467 test files, Vitest 4.1.10 --shard support) that cannot be verified against code. The platform already has a proven shard pattern in TEST-SUITE.yml (4 Jest shards with cross-validated list uploads and a union check), but the v1 plan diverges from it (single-source list, Vitest JSON format instead of Jest JSON) without verifiable evidence that the v1 workflow matches the plan's description. If any premise is wrong (e.g., check name differs, concurrency settings are missed, or there are additional jobs/steps that must be preserved), the implementation would break a required check.

- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:38` — gateway:
    name: Gateway (Jest, shard ${{ matrix.shard }}/4)
    ...
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    ...
    - name: List tests
      run: npx jest --listTests > list-${{ matrix.shard }}.txt
    ...
    - name: Upload shard result
- `exafyltd/vitana-platform:scripts/ci/test-suite/shard-union.mjs:32` — export function loadArtifacts(dir, shards) {
    ...
    for (let n = 1; n <= shards; n++) {
      const lf = path.join(dir, `list-${n}.txt`);
      ...
    if (lists.length > 1 && lists.some((l) => key(l) !== key(lists[0]))) errors.push('the shards listed different test files');

Suggestion: Include in the plan a verbatim snapshot of the current vitana-v1 UNIT-TESTS.yml (at least the vitest job definition, triggers, concurrency, and the exact check name) so premises can be verified. Alternatively, split the two lanes into separate plans so the platform lane (fully verifiable) can proceed independently.

### R1-F2 [minor]

The v1 shard-union design uploads the full file list (vitest list --filesOnly --json) from only shard 1. The proven platform pattern (TEST-SUITE.yml + shard-union.mjs) uploads npx jest --listTests from EVERY shard and cross-validates that all lists agree (shard-union.mjs lines 43-44). A single-source list means a subtle environment discrepancy in shard 1 goes undetected, and if shard 1's upload step fails after tests pass but before the list artifact is written, the aggregate job has no list to verify against.

- `exafyltd/vitana-platform:scripts/ci/test-suite/shard-union.mjs:36` — for (let n = 1; n <= shards; n++) {
      const lf = path.join(dir, `list-${n}.txt`);
      ...
    if (lists.length > 1 && lists.some((l) => key(l) !== key(lists[0]))) errors.push('the shards listed different test files (npx jest --listTests disagrees)');
- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:70` — - name: List tests
          run: npx jest --listTests > "list-${{ matrix.shard }}.txt"
          env:
            NODE_ENV: test
        - name: Run Jest suite
          run: npx jest --silent --maxWorkers=100% --shard=${{ matrix.shard }}/4 --json --outputFile="shard-${{ matrix.shard }}.json"

Suggestion: Have every shard run vitest list --filesOnly --json and upload the result, then have the aggregate cross-validate all lists (matching the platform pattern). Since vitest list ignores --shard, the lists should be identical and any disagreement signals an environment problem.

### R1-F3 [minor]

The plan says 'CICDL-GATEWAY-CI.yml installs the same lockfile in 7-9 s with --no-audit --no-fund and a warm runner' to justify the ENFORCE speedup. But CICDL-GATEWAY-CI.yml uses pnpm as its primary package manager with cache: 'pnpm' (line 65) — the gateway npm ci at line 92 does NOT benefit from pnpm's cache. The 7-9 s claim for the gateway npm ci step is unexplained, and the 50 s saving estimate for ENFORCE may be optimistic.

- `exafyltd/vitana-platform:.github/workflows/CICDL-GATEWAY-CI.yml:56` — - name: Setup pnpm
          uses: pnpm/action-setup@v3
          with:
            version: ${{ env.PNPM_VERSION }}

        - name: Setup Node.js
          uses: actions/setup-node@v4
          with:
            node-version: ${{ env.NODE_VERSION }}
            cache: 'pnpm'
- `exafyltd/vitana-platform:.github/workflows/CICDL-GATEWAY-CI.yml:90` — - name: Install gateway dependencies
          working-directory: services/gateway
          run: npm ci --no-audit --no-fund

Suggestion: Clarify the timing data: measure the ENFORCE npm ci step with the proposed npm cache on a test PR to get a real baseline, rather than comparing against the CICDL gateway install which runs in a different caching context.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
