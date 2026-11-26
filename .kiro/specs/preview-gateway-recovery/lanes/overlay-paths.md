---
lane: overlay-paths
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: jtadic
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
lane_admin: true
repos: [exafyltd/vitana-platform]
paths:
  - .kiro/specs/preview-gateway-recovery/lanes/runtime-profile.md
updated: 2026-11-26T12:40Z
---
# Lane `overlay-paths`: lane runtime-profile may change `scripts/aws/preview-sparring/task-overlay.json`
Tasks in `tasks.md` (group `<!-- lane: overlay-paths -->`). VTID from CI PLAN-SPAR or the owner's Rule 55 break-glass;
never by hand.

PR #5110 (lane `runtime-profile`) adds `scripts/aws/preview-sparring/task-overlay.json`, the environment of the
isolated preview task definition. That file is outside the lane's `paths` on `main` (binding review on #5110 head
`11eaf909af`: changes, "task-overlay.json is outside the lane's paths"). The owner's scope correction (2026-11-26) keeps
the file in #5110 and widens the lane by exactly that one path.

This is a `lane_admin` lane (VTID-05408): `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`, and its `paths`
are exactly the one target lane file (not its own file). It adds one entry to the target's `paths` and changes nothing
else in the target. Precedent: lane `agentic-delivery/nav-paths` (VTID-05563, #4722).

## Log
### 2026-11-26T12:40Z · kiro-jtadic-202611261230-51b4 · created → ready
Late lane proposed for the plan driver's `_plan` amendment. next_actor owner: it needs a VTID (CI PLAN-SPAR cannot
allocate while the preview rejects the shared token, and allocation is forced off by plan-spar-token) and the plan
amendment needs the same Rule 55 authority as #5137.
