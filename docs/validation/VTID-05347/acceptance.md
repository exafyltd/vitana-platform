# VTID-05347 acceptance (quality-checks/staging-manifest-bom, tasks.md T1-T3)

Change types: Infrastructure/CI. Red-on-base: `red-on-base.txt` (4 new tests fail, 62 pass). Commands: `commands.log`.

AC-1 A `staging-tests.json` with one leading UTF-8 BOM is read by `loadManifest` (exported from `run.mjs`, used by
`check-pr` and STAGING-VERIFY) as the same object as without it; a missing file is still `null`; invalid JSON still
yields `__parseError`.
TEST: node --test scripts/ci/staging-verify/lib.test.cjs

AC-2 A `commit-coverage.json` with a leading BOM gives the same `parseCommitCoverage` result as without it (the
`run.mjs` coverage read uses `parseJsonText`).
TEST: node --test scripts/ci/staging-verify/lib.test.cjs

AC-3 `parseJsonText` removes exactly one leading U+FEFF: invalid JSON, empty input, a lone BOM, two BOMs and a
trailing BOM still throw `SyntaxError`.
TEST: node --test scripts/ci/staging-verify/lib.test.cjs

AC-4 `validateManifest`, `planRange`, `decideOutcome` unchanged; no test changed or removed; every staging-verify
suite green; deploys nothing.
TEST: node --test scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/workflow.test.cjs scripts/ci/staging-verify/confirm-live.test.mjs scripts/ci/staging-verify/record-oasis.test.cjs
