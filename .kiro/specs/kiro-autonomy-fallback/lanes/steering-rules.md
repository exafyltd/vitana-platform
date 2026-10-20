---
lane: steering-rules
state: ready
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
updated: 2026-10-20T17:49Z
vtid: VTID-05278
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
