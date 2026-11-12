---
lane: local-test-stack-pglite
state: done
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/tests/fixtures/**
  - supabase/tests/local-stack/**
  - scripts/mt/stack/**
  - docs/multitenancy/LOCAL-STACK.md
  - .github/workflows/MT-LOCAL-STACK.yml
  - package.json
  - pnpm-lock.yaml
updated: 2026-11-08T14:12Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05520
---
# D11 local stack on PGlite — mt-guardrails-r2/local-test-stack-pglite (repo vitana-platform)

This lane builds the D11 local stack in-process on PGlite, one database per test file, as Amendment 2 of `.kiro/specs/mt-guardrails-r2/plan.md` decides. The Docker replay of `local-test-stack-v2` (PR #4628) did not meet its required tables, so `local-test-stack` and `local-test-stack-v2` are superseded and not built. The lane seeds synthetic fixtures from `supabase/tests/fixtures/`, applies the lanes' migrations in timestamp order with the skips in `supabase/tests/local-stack/replay-skip.json`, and runs the suites through a pgTAP-compatible shim on PGlite in CI with no Docker. Real pgTAP is not used on this stack, and the acceptance in `tasks.md` says so. Tasks P1–P4 and their acceptance are in the `local-test-stack-pglite` group of `tasks.md`. There is no production dump, no live call and no secret. VTIDs come from CI PLAN-SPAR on convergence, never by hand.

## Log
### 2026-11-02T20:00Z · kiro-hotmail-202611011452-6d16 · ready
Created by plan amendment 2 (owner decision, 2026-11-02). No VTID yet.

### 2026-11-02T20:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05520 allocated after policy approval (converged-auto-v1).

### 2026-11-08T13:28Z · agent-vitana-lane-reviewer-202611081328-4bc0 · review
review: accept
head: c3cfcba229c88ae18819c8a7369ac5d9a6638983
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4879
Findings: B1 fixed (push trigger with no path filter, run 42480237647 success on head); B2 fixed (LOCAL-STACK.md "Isolation gap on the present tables" lists 44 skipped migrations incl. the four named, doc/scan agreement test); no test loosened (replay-skip.json reason lines only; repo-gate assertion stricter); all files inside lane paths; no protected gate file touched. Non-blocking: ci-runs.md does not record the run on the final head (42480237647); every-push-to-main cost not bounded by acceptance.
Next: the land step merges under §7b

### 2026-11-08T13:50:00Z · agent-vitana-lane-reviewer-202611081347-e5d8 · review
review: accept
head: 5cbb85a62476a686d1cef168fa78913373f5da60
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4879
Findings: none blocking. PR's own diff (origin/main...5cbb85a624) is 41 files, all lane files; content of every lane path identical to the accepted c3cfcba229 (diff empty); only changes since are the review-entry commit on the lane file and the merge of origin/main (#4869 MORNING-SYSTEM-HEALTH-CHECK.yml, from main, not this lane); no protected gate file in the PR's own diff; B1/B2 fixes intact, no test loosened. Non-blocking: MT local stack (PGlite) check-run on this head unverified by the reviewer (check-runs API not readable from this role; run 42480237647 was success on c3cfcba229), land-guard must confirm green; ci-runs.md does not record the final-head run; every-push-to-main cost not bounded by acceptance.
Next: the land step merges under §7b once land-guard confirms every check green on this head

Collab-Session: agent-vitana-lane-reviewer-202611081347-e5d8
Collab-Review: mt-guardrails-r2/local-test-stack-pglite
Collab-Verdict: accept
Collab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
Collab-Reviewed-Head: 5cbb85a62476a686d1cef168fa78913373f5da60

### 2026-11-08T14:08Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-guardrails-r2/local-test-stack-pglite; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-08T14:08Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4879. Reviewed on head `5cbb85a624` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-08T14:08Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: 932da573be7360831e5f5822f81da9b9b5972338 (exafyltd/vitana-platform#4879)
authority: §7b PM rule. Squash merge by land-guard; `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
Next: the `done` record.

### 2026-11-08T14:12Z · kiro-hotmail-202611061752-cc1f · verified → done
Merged and verified under §7b (record 1). This lane deploys nothing: it adds the MT local stack (PGlite) workflow, fixtures and shim, which run in CI only. No staging deploy and no STAGING-VERIFY apply; the lane is done at merge with green checks and these closing records.
