---
lane: rules-trim
state: ready
next_actor: kiro
depends_on: []
executor: claude
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - CLAUDE.md
  - .kiro/steering/vitana-kiro-notes.md
  - .kiro/steering/vitana-load-project-rules.md
updated: 2026-10-20T21:21Z
vtid: VTID-05280
---
# rules-trim — trim platform CLAUDE.md to project-specific rules; fix Kiro steering (repo vitana-platform)
Plan: `.kiro/specs/claude-md-cleanup/plan.md` (lane `rules-trim`, items A–M, Numbering, MUST KEEP) and the
`rules-trim` section of `tasks.md` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here. Deploys nothing.
**Builder: Kiro** (owner instruction 2026-10-20). `executor: claude` is the value `queue.mjs validateLane`
(`:231-235`) requires for a lane declaring the protected gate file `CLAUDE.md` — same bootstrap as
`kiro-autonomy-fallback/steering-rules`; it does not hand the lane to Claude Code (plan Decision 2).
Protected gate file touched: `CLAUDE.md` → the lane PR is not merged by Kiro; it waits for owner review on the current
head (plan Decision 3). `.claude/CLAUDE.md` is not edited. Evidence: the lane's own `docs/validation/<VTID>/`.
Branch `kiro/claude-md-cleanup/rules-trim`; PR title `VTID-xxxxx (claude-md-cleanup/rules-trim): …`; trailers
`Collab-Session`/`Collab-Lane: claude-md-cleanup/rules-trim`.
## Log
### 2026-10-20T19:55Z · kiro-202610201939-ee07 · created → ready
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, Kiro claims and builds it.

### 2026-10-20T21:21Z · ci-plan-spar · ready (VTID allocated)
VTID-05280 allocated after policy approval (converged-auto-v1).
