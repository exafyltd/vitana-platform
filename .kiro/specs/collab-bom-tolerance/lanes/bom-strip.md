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
updated: 2026-11-02T11:22Z
vtid: VTID-05462
---
# Lane: bom-strip (repo vitana-platform)
Tasks T1-T4 in `tasks.md`. **Paths (authoritative for the build, not declared in front matter):**
`scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `docs/validation/VTID-*/**` (this lane's own VTID only).
They are not declared as `paths:` because `validateLane` (`queue.mjs:238-241`) refuses an `executor: kiro` lane whose
glob reaches a protected gate file; this follows the `kiro-lane-admin/enforcement` lane on `main`.
**Protected gate file (§3a):** this lane changes `scripts/collab/queue.mjs`. Merge only on the owner's instruction
naming `collab-bom-tolerance` (recorded in this lane's log) plus a reviewer-agent accept on the current head, with
every required check green. Never on a reviewer-agent accept alone; the Project Manager never merges it
(`governance.ts:185` refuses `protected_gate_file`). Held until PLAN-SPAR allocates this lane's VTID.
## Log
### 2026-11-01T23:15Z · kiro-exafyltd-202611012315-0b54 · ready
Lane created with the plan.

### 2026-11-02T11:22Z · ci-plan-spar · ready (VTID allocated)
VTID-05462 allocated after policy approval (converged-auto-v1).
