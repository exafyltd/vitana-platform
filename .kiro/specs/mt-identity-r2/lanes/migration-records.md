---
lane: migration-records
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - docs/validation/**
updated: 2026-11-02T16:06Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05479
---
# migration-records — MIGRATION-QUEUE rows + drift baseline for the four mt-identity-r2 DB slices
Added by Amendment 1: both files are hot and outside the DB lanes' paths. Merges before any DB lane. No migration,
no apply. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-02T14:00Z · kiro-hotmail-202611011452-6d16 · created
Created through `_plan` (Amendment 1).

### 2026-11-02T16:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05479 allocated after policy approval (converged-auto-v1).

### 2026-11-02T17:51Z · agent-vitana-lane-reviewer-202611021751-6b06 · review
review: accept
head: 59b1ec0c3c200f4d7de189546ac4616c11a058db
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4633
Findings:
- non-blocking · scripts/ci/migration-drift-baseline.json · All 11 checks on this head are queued and none has failed; the land step needs all green. Read-only trace of the baseline consumers (check-migration-drift.test.cjs, mt-launch-pack-intake-pgtap.test.ts:226-230), the sparring record and staging-tests.json found no conflict.
- non-blocking · docs/multitenancy/MIGRATION-QUEUE.md:30 · Depends-on is partly inferred (row 14 "#13", row 19 "#14, #16" without #15; rows 12-13 omit the live-object guards); the top-to-bottom order stays safe.
- non-blocking · docs/multitenancy/MIGRATION-QUEUE.md:28 · The reminder to remove the two baseline entries after the apply lives only in _comment_vtid_05479, which --update-baseline drops; the Apply window cell is identical on all nine rows and says "not applied by this PR".
- non-blocking · docs/validation/VTID-05479/commands.log:9 · The git diff output is abbreviated and the red-on-base results are not recorded; both TEST lines are red on base by construction and PR-GATE skips red-to-green for kind docs.
- non-blocking · docs/multitenancy/MIGRATION-QUEUE.md:38 · Rows were checked against the lane worktrees at their branch heads; the role-source head's push is unconfirmed, and the DB lanes cannot correct their rows here, so a later rename needs another records change.
Next: the land step merges under §7b once every check is green on this head; this lane merges before any DB lane (plan Amendment 1).
