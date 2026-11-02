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

### 2026-11-02T19:09Z · agent-vitana-lane-reviewer-202611021909-902c · review
review: accept
head: 691809ced21f629120bafedaece329ece8f042b1
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4633
Findings:
- non-blocking · scripts/ci/migration-drift-baseline.json · All 12 checks on this head are queued and none has failed (the first accept saw 11; the extra `wake` is the advisory DRIVER-WAKE job, whose steps are continue-on-error), so the land step waits for every check to go green. Baseline on this head: `count` 110 equals the 110 list entries (lines 7-116; base 108) and both names sit in sort order. check-migration-drift.cjs uses the baseline only to exclude known-missing tables and to print recovered ones, and check-migration-drift.test.cjs and mt-launch-pack-intake-pgtap.test.ts:226-230 stay consistent, so `drift` and `unit` should not fail on these entries. The DB-lane drafts create only these two public tables; their legacy_archive.bak_* snapshots are non-public and need no entry.
- non-blocking · .kiro/specs/mt-identity-r2/lanes/migration-records.md · Confirmed on 691809ce: the diff against main is the nine queue rows 12-20, the two baseline entries (membership_drift_reports, tenant_claim_mismatch_log) with count 110, the six docs/validation/VTID-05479 files, and this lane file's +13 log lines (my first entry, allowed by item 2). The merge (a clean 'ort' merge of origin/main on top of review-entry commit 577cec3b; local and remote-tracking refs both at 691809ce) changed none of those lines: every blob id matches the diff I accepted at 59b1ec0c, including the base blobs of the two shared files (queue abac2cfcd8, baseline 312b95d5d7), so main did not touch them up to the merged commit. No migration, workflow or script file is in the diff, so nothing here can apply a migration or reach a live system; commands.log lists local commands only.
- non-blocking · docs/multitenancy/MIGRATION-QUEUE.md:30 · Depends-on is partly inferred and differs from the lane files: membership-unification has depends_on [] yet row 14 says '#13'; row 19 lists '#14, #16' without #15; row 18 lists '#17' although the hook function (row 17) logs inside an exception block and tolerates a missing table; rows 12 and 13 do not name the live objects their guards need (row 12 refuses without user_tenants and its unique (tenant_id, user_id) index, row 13 without current_tenant_id()). Applying strictly top to bottom, as the file header requires, stays safe.
- non-blocking · scripts/ci/migration-drift-baseline.json:165 · The reminder to remove the two entries after their apply lives only in _comment_vtid_05479, which --update-baseline rewrites away, and the Notes section of the queue has no bullet for rows 12-20 (it has them for rows 5 and 9-10). Task Q2 also asks for a comment line per entry with the words 'pending owner-approved apply'; one sibling key covers both entries and says 'queued ... not applied', which means the same.
- non-blocking · docs/validation/VTID-05479/commands.log:9 · The git diff --name-only output is abbreviated (docs/validation/VTID-05479/...) and the red-on-base results are not recorded. The queue grep and the baseline count are red on base by construction (0 rows; 108 and 108), and PR-GATE skips red-to-green when no VTID is of kind fix (scripts/ci/pr-gate/gate.mjs:104-105; scope.json kind is docs). AC-3 lists three paths only, and the lane file now also appears in the diff because its log entry was added after commands.log ran.
- non-blocking · docs/multitenancy/MIGRATION-QUEUE.md:38 · Re-checked the nine forward files, four rollback files and VTIDs (05464 hook, 05465 helpers, 05466 membership, 05467 role source) against the lane files and the four DB-lane worktrees: every name matches, including the membership and role-source names I could not confirm last time. Those files are not part of this PR, so a later rename in a lane still needs another records change, which the lanes' paths do not allow.
Next: the land step merges under §7b once every check is green on this head and the branch is up to date with latest main; this lane merges before any DB lane (plan Amendment 1).
