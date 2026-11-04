# VTID-05513 — Acceptance (platform: superseded PR runs cancel per PR)

Scope of THIS PR: concurrency block on the 38 PR-triggered workflows listed in the lane file, one guard test, and its
npm script. Production workflows, PR-GATE.yml, PLAN-SPAR.yml and the three workflows that already had a concurrency
block (UNIT, TEST-SUITE, PHASE-2B-DOC-GATE) are not changed.

AC-1 — Each of the 38 lane workflows has the per-PR concurrency block exactly once, with cancel-in-progress only on pull_request
  TEST: scripts/ci/superseded-concurrency.test.mjs (the 38 lane workflows carry the block exactly once)

AC-2 — Protected gate files and production workflows do not carry the block
  TEST: scripts/ci/superseded-concurrency.test.mjs (protected gate files and production workflows are not changed)

AC-3 — Workflows that already had concurrency keep their own group
  TEST: scripts/ci/superseded-concurrency.test.mjs (workflows that already had a concurrency block keep their own group)

AC-4 — Push-to-main and scheduled runs are never cancelled by the block (cancel-in-progress is the pull_request expression)
  TEST: scripts/ci/superseded-concurrency.test.mjs (the 38 lane workflows carry the block exactly once)
