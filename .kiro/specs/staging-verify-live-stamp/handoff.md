---
slug: staging-verify-live-stamp
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-13T17:37Z
---
# Handoff — STAGING-VERIFY resolves the live-served commit when commit_sha is omitted
Task given to this session: `STAGING-VERIFY.yml`'s `workflow_dispatch` requires `commit_sha` and uses it as-is, with
no cross-check against what staging actually serves — the cause of run
https://github.com/exafyltd/vitana-platform/actions/runs/43434282759 burning a full run against the wrong commit.
Plan block: `plan.md`. One lane: `lanes/fix.md` (`tasks.md` section `<!-- lane: fix -->`).

**Never** (collaboration.md §7a): no VTID allocation by hand, no merge except §7b, no workflow dispatch outside the
§7a re-run allowlist, no live write, no test against production.

## Log
### 2026-11-13T17:37Z · kiro-exafyltd-202611131736-78e6 · created → drafted
Holder of the `staging-verify-live-stamp/_plan` claim. Read `STAGING-VERIFY.yml`, `STAGING-VERIFY-NIGHTLY.yml`,
`scripts/ci/staging-verify/run.mjs` in full, and `workflow.test.cjs` (the existing static-text test convention for
this exact workflow file) before writing the plan. Implemented the fix and the test in this same session ahead of
sparring (small task, 1 lane, 2 files — `.kiro/pipeline/planning.md` small-task path), so the PR carries working code
from the start; PLAN-SPAR sparring the plan text still gates the VTID. No VTID allocated, no live system touched, no
merge performed.
Next: push `plan(staging-verify-live-stamp)`; PLAN-SPAR spars it; this session (or whichever session is driving)
answers each round in `sparring/responses-<n>.md`.
