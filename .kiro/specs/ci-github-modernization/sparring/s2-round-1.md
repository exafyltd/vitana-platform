# Sparring round 1 — in_progress

Session: `747f12ec-e8df-4e28-ad15-1d2b781fa355` · plan hash `5a6d5a76c3cc44b2fdd86bd547c3a9ce3fafc292d96034f5a5cbe05fc97f9d86`

## Summary

The plan is generally well-structured (correct governance-lane split, protected-gate isolation, deferred owner-config items), but it is built on two factually wrong premises about the existing CI system that materially affect the lane structure and dependency graph. (1) Lane 1's core claim — that VCAOP-CICD.yml is the *only* place running the vcaop `typecheck` and `test:guardrails` gates and that deleting it would "silently lose" them, motivating a migration into TEST-SUITE.yml (lane 6) plus a lane-1→6 dependency — is false: `VCAOP-GUARDRAILS-CI.yml` already runs `npm run typecheck` and `npm run test:guardrails` (with `--runInBand`) on the same triggers. (2) The "Today" narrative claims TEST-SUITE runs the gateway as "one job, not 4 shards", but TEST-SUITE.yml has a `shard: [1,2,3,4]` matrix — the brief's "4 shards" was correct and the plan's "correction" is wrong. These are wrong assumptions about existing code, not changes, and must be corrected before implementation.

## Findings

### R1-F1 [major]

Lane 1's premise — that VCAOP-CICD.yml is the ONLY workflow running the vcaop `typecheck` and `test:guardrails` gates, so deleting it would 'silently lose' both and requires a migration into TEST-SUITE.yml — is false. A separate workflow, VCAOP-GUARDRAILS-CI.yml, already runs `npm run typecheck` and `npm run test:guardrails` (and full `npm test`) on the same pull_request/push triggers for `services/vcaop/**`. Deleting VCAOP-CICD.yml loses nothing. The entire lane-6 vcaop-matrix migration and the lane-1 `depends_on: [speed-path-filters]` dependency are predicated on a non-existent coverage gap.

- `exafyltd/vitana-platform:.github/workflows/VCAOP-GUARDRAILS-CI.yml:36` — - name: Typecheck
  working-directory: services/vcaop
  run: npm run typecheck
- name: Guardrail tests (required gate)
  working-directory: services/vcaop
  run: npm run test:guardrails
- name: Unit tests (full suite)
  working-directory: services/vcaop
  run: npm test
- `exafyltd/vitana-platform:.github/workflows/VCAOP-CICD.yml:37` — - name: Typecheck ... run: npm run typecheck
- name: Guardrails (REQUIRED gate — blocks on failure) ... run: npm run test:guardrails

Suggestion: Correct the inventory and lane 1: VCAOP-GUARDRAILS-CI.yml already covers the vcaop typecheck + guardrails gates, so deleting VCAOP-CICD.yml (whose only unique-but-dead body is the gated `deploy-dev` GCP job) loses no gate. Remove the lane-6 vcaop-matrix migration and the lane-1→6 dependency, or justify them only if there is a concrete reason the `typecheck`/`test:guardrails` gates need to ALSO run under TEST-SUITE (e.g. making TEST-SUITE the single required check) — and if so, state that the duplicated run is intentional, not a gap.

### R1-F2 [minor]

The 'Today' section asserts 'TEST-SUITE runs the gateway suite with --maxWorkers=100% (one job, not the 4 shards the brief assumed)'. This is wrong: TEST-SUITE.yml has a `strategy.matrix.shard: [1, 2, 3, 4]` and the job name is 'Gateway (Jest, shard ${{ matrix.shard }}/4)', running `--shard=${{ matrix.shard }}/4`. The brief's '4 shards' was correct; the plan's 'one job' correction is a false premise that feeds the measurement section and lane 6's 're-balance the gateway Jest shards'.

- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:43` — gateway:
  name: Gateway (Jest, shard ${{ matrix.shard }}/4)
  runs-on: ubuntu-latest
  timeout-minutes: 25
  strategy:
    fail-fast: false
    matrix:
      shard: [1, 2, 3, 4]
- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:69` — - name: Run Jest suite
  run: npx jest --silent --maxWorkers=100% --shard=${{ matrix.shard }}/4 --json --outputFile="shard-${{ matrix.shard }}.json"

Suggestion: Correct the 'Today' narrative and measurement section: TEST-SUITE's gateway suite is 4 parallel shards (one job per shard), not a single job. Reconcile with lane 6's shard re-balancing and the ground-truth gateway count (~1,737 suites / ~22,700 tests across 4 shards).

### R1-F3 [minor]

The plan's rationale for adding a separate run-in-band guardrails step (that the guardrails suite fails under parallel Jest workers) is inconsistent with the existing workflows: `npm test` (the bare `jest` script) already runs the `test/guardrails` directory in parallel in VCAOP-CICD.yml, VCAOP-GUARDRAILS-CI.yml, and TEST-SUITE.yml's vcaop entry. If guardrails genuinely fails under parallel workers, those existing `npm test` runs would already be red today; if it does not, the `--runInBand` requirement motivating the new step is unproven. Either way the premise needs reconciling, not assertion.

- `exafyltd/vitana-platform:services/vcaop/package.json:10` — "test": "jest",
"test:guardrails": "jest --runInBand test/guardrails"
- `exafyltd/vitana-platform:.github/workflows/VCAOP-GUARDRAILS-CI.yml:44` — - name: Unit tests (full suite)
  working-directory: services/vcaop
  run: npm test
- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:111` — - service: vcaop
  install: npm install --no-audit --no-fund
  test: npm test
  runner: jest

Suggestion: Verify (or cite the test that proves) the guardrails suite actually fails under parallel workers, and reconcile with the fact that `npm test` already runs it in parallel in three workflows today. If the `--runInBand` claim is stale, the new guardrails step is unnecessary; if it is real, the existing parallel `npm test` runs are already broken and that is itself a finding for ci-health.

### R1-F4 [minor]

Lane 3's false-positive fix list says to stop counting 'ci-plan-spar/pm-agent as a second session'. But `pm-agent` is ALREADY excluded from the per-lane session counting (`if (k.lane && k.session !== PM_AGENT)` only adds non-pm-agent sessions), so the 'pm-agent counted as a second session' half targets a non-issue; only `ci-plan-spar` is actually counted into `sessionsByLane` and can trip the 'one session per lane' check. The lane's own description of the bug is partly wrong.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:452` — if (k.lane && k.session !== PM_AGENT) {
  if (!sessionsByLane.has(k.lane)) sessionsByLane.set(k.lane, new Set());
  sessionsByLane.get(k.lane).add(k.session);
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:476` — for (const [lane, sessions] of sessionsByLane) {
  if (sessions.size > 1) errors.push(`lane ${lane}: commits from ${sessions.size} sessions ...`)

Suggestion: Refine lane 3's bug description to the accurate cause (ci-plan-spar counted as an extra session on a `_plan` lane), and verify with a red-on-base test before writing the pm-agent portion of the fix, which appears to already be handled.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
