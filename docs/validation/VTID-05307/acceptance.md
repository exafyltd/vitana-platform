# VTID-05307 — ci-github-modernization/speed-path-filters acceptance

Lane acceptance: `.kiro/specs/ci-github-modernization/lanes/speed-path-filters.md` (plan `plan.md`, tasks `tasks.md`).
Speed-only CI change — dependency caching on the gateway Jest shards and the `pr-gate` job, the 4-shard gateway
matrix kept intact (VTID-05272), and **no path filter on any required gate job**. Deploys nothing; no runtime or
service change.

Suites: `scripts/ci/test-suite/shard-union.test.mjs` and `scripts/ci/test-suite/rerun-policy.test.mjs`
(15 tests total). Output: `outputs/node-test-shard-rerun.txt`. Red → green proof: `red-on-base.txt`, `commands.log`.
Measured before/after critical path: `measured-critical-path.md`.

AC-1 — The gateway Jest shards and the `services` matrix in `TEST-SUITE.yml` declare dependency caching on their
`setup-node` steps (pnpm store keyed on the root `pnpm-lock.yaml` for the gateway shards; per-entry `npm`/`pnpm`
cache keyed on each service's lockfile for the matrix), and the 4-shard gateway matrix survives unchanged — not
collapsed, no shard-count change.
TEST: scripts/ci/test-suite/shard-union.test.mjs › TEST-SUITE.yml: install steps declare dependency caching and the 4-shard matrix survives

AC-2 — `PR-GATE.yml` adds an `npm` cache on the `pr-gate` job's `setup-node` (keyed on
`services/gateway/package-lock.json`), the gate still runs on every `pull_request` with no `paths`/`paths-ignore`
filter (a path-filtered required check stays pending and wedges merges — inv-code §5), and `enforce` is untouched.
TEST: scripts/ci/test-suite/shard-union.test.mjs › PR-GATE.yml: speed caching added but the gate still runs on every PR (never path-filtered) and enforce is untouched

AC-3 — The shard-union contract is intact: the gateway runs as 4 shards, the union job checks all four, and the
summary requires all three services — a missing shard result or disagreeing lists are errors.
TEST: scripts/ci/test-suite/shard-union.test.mjs › TEST-SUITE.yml: gateway runs as 4 shards, the union job checks them, the summary needs all three
TEST: scripts/ci/test-suite/shard-union.test.mjs › loadArtifacts: a missing shard result or lists that disagree are errors

AC-4 — The TEST-SUITE rerun policy is unchanged by this speed work: a Jest run that failed with a printed summary
is real and is not re-run; a `services` matrix install failure is infra; the rerun workflow triggers only on
TEST-SUITE failure, attempt 1, with the policy read from the default branch.
TEST: scripts/ci/test-suite/rerun-policy.test.mjs › Jest ran and failed (summary printed) → no re-run
TEST: scripts/ci/test-suite/rerun-policy.test.mjs › TEST-SUITE-RERUN.yml: workflow_run of TEST-SUITE, failure + attempt 1 only, policy from the default branch

MERGE_PAYLOAD_PREVIEW: CI-config + test + docs only; deploys nothing (no staging-tests.json required).
OASIS_IMPACT: no — this lane changes no runtime path, emits no new OASIS event and changes no event payload.
