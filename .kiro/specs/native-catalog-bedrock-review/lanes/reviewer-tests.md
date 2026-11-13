---
lane: reviewer-tests
state: ready
next_actor: kiro
depends_on: [reviewer-script]
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: tooling
repos: [exafyltd/vitana-v1]
paths:
  - scripts/i18n/__tests__/bedrock-review.test.mjs
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-13T08:48Z
---
# Bedrock translation reviewer tests (fake runner)
Plan: `.kiro/specs/native-catalog-bedrock-review/` — `plan.md` and the `tasks.md` section marked
`<!-- lane: reviewer-tests -->` (tasks T1–T7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** `scripts/i18n/__tests__/bedrock-review.test.mjs` proves the reviewer with `node:test` and a fake AWS runner. It
covers the identity guard, the verdict record, fail-closed parsing and the dry run. No test calls AWS, Bedrock or the
network.

**Acceptance (reviewer: hotmail):** the suite fails on `origin/main` before `reviewer-script` lands (module not found) and
passes after it; no assertion is skipped or loosened; the record test pins the eight fields; `node --test
scripts/i18n/__tests__/bedrock-review.test.mjs` passes in vitana-v1 CI with no credential.

**Never:** no real AWS credential, no network call in the suite, no import or copy of the #1680 checker.

## Log
### 2026-11-13T08:48Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.
