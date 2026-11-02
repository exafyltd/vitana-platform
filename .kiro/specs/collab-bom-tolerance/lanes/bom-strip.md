---
lane: bom-strip
state: ready
next_actor: kiro
branch: kiro/collab-bom-tolerance/bom-strip
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform]
updated: 2026-11-01T23:15Z
---
# Lane: bom-strip (repo vitana-platform)
Tasks T1-T4 in `tasks.md`. **Paths (authoritative for the build, not declared in front matter):**
`scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `docs/validation/VTID-*/**` (this lane's own VTID only).
They are not declared as `paths:` because `validateLane` (`queue.mjs:238-241`) refuses an `executor: kiro` lane whose
glob reaches a protected gate file; this follows the `kiro-lane-admin/enforcement` lane on `main`. `queue.mjs` is
protected (§3a): the merge needs the owner's instruction naming `collab-bom-tolerance` plus a reviewer-agent accept on
the current head. Held until PLAN-SPAR allocates this lane's VTID.
## Log
### 2026-11-01T23:15Z · kiro-exafyltd-202611012315-0b54 · ready
Lane created with the plan.
