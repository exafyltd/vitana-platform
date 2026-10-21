---
slug: collab-queue-perf
author: kiro
executor: claude
next_actor: kiro
state: approved
updated: 2026-10-21T11:24Z
sparring_record: .kiro/specs/collab-queue-perf/sparring/verdict.md
vtids: [VTID-05300]
---
# Handoff — collab-queue-perf
`queue.mjs` collect() spawns one git process per branch, per spec file and per claim; on Windows that is
75–150 s per two-repo run, past the 120 s tool timeout. This batches it into ≤ 6 processes per repo.
Plan: `plan.md`. Requirements, design and tasks are alongside.
Lanes:
- `queue-batch-read`: executor **claude** (governance path `scripts/collab/**`), reviewer `exafy`.
## Log
### 2026-10-18T20:10Z · kiro-202610181950-f0b7 · drafted
Authored from measurements on the owner's machine (timings in `plan.md`) and `queue.mjs` collect()/listClaims().
Corrects the earlier estimate: one git spawn is 0.13–0.4 s (not 0.9 s per diff), and `--days 3` still took
149 s end to end because vitana-platform's cost is spec-file reads, not branch diffs. Branch cleanup and
vitana-v1 auto-delete are left out on purpose (owner decision, deletes branches on GitHub). Next: PLAN-SPAR
spars this PR; Claude Code builds the lane, possibly together with `sparring-floor-retry/floor-retry-code`.

### 2026-10-18T20:30Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-21T11:24Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
