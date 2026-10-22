---
lane: steering-rules
state: parked
next_actor: kiro
depends_on: []
executor: claude
seat: exafyltd
area: frontend
reviewer_seat: jtadic
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform, exafyltd/vitana-v1]
paths:
  - .claude/rules/collaboration.md
  - CLAUDE.md
  - .kiro/steering/vitana-kiro-notes.md
  - .kiro/steering/vitana-load-project-rules.md
  - .kiro/steering/vitana-standing-rules.md
  - .kiro/steering/vitana-collaboration.md
  - .kiro/steering/vitana-pipeline.md
  - docs/validation/VTID-*/**
branch: kiro/kiro-autonomy-fallback/steering-rules
pr: https://github.com/exafyltd/vitana-platform/pull/4226
updated: 2026-10-22T22:29Z
vtid: VTID-05278
parked_from: executing
---
# steering-rules — rule text first: Claude optional, PM merge rule, plan driver, parallel rule, measurement (both repos)
Plan: `.kiro/specs/kiro-autonomy-fallback/plan.md` §5 A and the `steering-rules` section of `tasks.md` are authoritative.
VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. No `depends_on`; lands first.
Repos: vitana-platform (PR 1) and the vitana-v1 mirror (PR 2, same VTID, the same relative paths:
`c:/Users/dstev/vitana-v1/.claude/rules/collaboration.md`, `CLAUDE.md`, `.kiro/steering/{vitana-kiro-notes,
vitana-load-project-rules,vitana-standing-rules,vitana-collaboration,vitana-pipeline}.md`). Deploys nothing.
**Bootstrap (plan §6):** `executor: claude` is the value today's validator requires for these governance paths
(`queue.mjs:180,471`); Kiro seat `exafyltd` builds the lane under the owner's §7b instruction. Acceptance by
`agent:vitana-lane-reviewer (claude-sonnet-5.5)`; the review entry is committed under the legacy `reviewer_seat` jtadic.
Protected gate file touched: `CLAUDE.md` (owner instruction, plan §6). Hot file: `CLAUDE.md` (only this lane edits it).
Shared files: none.
## Log
### 2026-10-20T17:20Z · kiro-exafyltd-202610201618-c018 · created → ready
Owner instruction 2026-10-20: "no more approvals, you run it end to end" — §7b merge instruction for this plan's named
set (plan PR + every lane PR, both repos), approvals from the reviewer agent on claude-sonnet-5.5, this lane lands first.
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafyltd claims it.

### 2026-10-20T17:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05278 allocated after policy approval (converged-auto-v1).
### 2026-10-20T18:22Z · kiro-exafyltd-202610201618-c018 · ready → executing
Claimed (`collab-claim/kiro-autonomy-fallback/steering-rules`, df72a7970a). Owner instruction 2026-10-20 ("no more
approvals, you run it end to end", plan §6, collaboration.md §7b named set) covers building, merging this lane's two PRs
and the protected gate file `CLAUDE.md` (roles paragraph only). Implemented plan §5 A / tasks A1-A4: collaboration.md
(intro, §2, §3, §3a, §4, §5, §7, §7a, §7b PM merge rule, §8 plan driver, new §8a parallel execution, new §8b
measurement, §9), CLAUDE.md roles paragraph, the four steering files and the new `vitana-pipeline.md`; vitana-v1
mirror on the same branch name with byte-identical files. Lane state stays `executing` in the PR (base `ready` →
`in-review` is not a legal single-PR transition for `queue.mjs validate`); the PR is open for review by
agent:vitana-lane-reviewer (claude-sonnet-5.5). Next: review → land (lands first).PRs: https://github.com/exafyltd/vitana-platform/pull/4226 (platform), https://github.com/exafyltd/vitana-v1/pull/1468 (vitana-v1 mirror).

### 2026-10-20T20:34Z · kiro-jtadic-202610201807-022d · review
review: accept
head: ed3add2f7716a1ca7f39332b28dd01bfca071f03 (vitana-v1 mirror f11a840b4454da835e4873c7aece41b5276678b2)
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PRs: https://github.com/exafyltd/vitana-platform/pull/4226, https://github.com/exafyltd/vitana-v1/pull/1468
Findings (non-blocking): validate-pr needs a VALIDATION_PROFILE line in the PR body; the CLAUDE.md roles paragraph
keeps the stale two-seat parenthetical (later governance lane); some CI still running at review time.
Entry committed by the land step on the reviewer agent's behalf. Next: land (owner instruction 2026-10-20, ).
### 2026-10-22T18:17Z · pm-agent · executing → parked
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T18:21Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T18:25Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T18:29Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T18:33Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T18:37Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T18:41Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:05Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:09Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:13Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:17Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:21Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:25Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:29Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:33Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:37Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T19:41Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:05Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:09Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:13Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:17Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:21Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:25Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:29Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:33Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:37Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:41Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:45Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:49Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T20:53Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:05Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:09Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:13Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:17Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:21Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:25Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:29Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:33Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T21:37Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:05Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:09Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:13Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:17Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:21Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:25Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
### 2026-10-22T22:29Z · pm-agent · update
park (stale_claim); claim released; Claude unavailable → exafyltd
