---
lane: work-surface-permission-v2
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/orb/profile/assistant-profile.ts
  - services/gateway/src/orb/live/session/live-session-controller.ts
  - services/gateway/src/routes/orb-livekit.ts
  - services/gateway/src/routes/conversation.ts
  - services/gateway/test/mt-track-s-authz-work-surface.test.ts
  - services/gateway/test/routes/orb-livekit.test.ts
  - docs/validation/**
updated: 2026-11-03T16:40Z
vtid: VTID-05529
---
# Lane: work-surface-permission-v2 (repo vitana-platform)
Supersedes `work-surface-permission` (seat exafy, VTID-05453). The lane's paths cannot be amended from another seat, because lane permissions come from the base revision. This lane carries the same work with the same tasks and acceptance, and `services/gateway/test/routes/orb-livekit.test.ts` (on main, pinned to the previous contract by three assertions) is in scope. The code base is the `work-surface-permission` branch, PR #4654 (draft, head `5a7406dde6`). Tasks: `tasks.md`, group `work-surface-permission-v2`. The VTID is allocated by CI on convergence.

## Log
### 2026-11-03T15:05Z · kiro-hotmail-202611011452-6d16 · created
Created by plan amendment wsp-1 (mt-track-s-authz), which supersedes `work-surface-permission`.

### 2026-11-03T16:40Z · ci-plan-spar · ready (VTID allocated)
VTID-05529 allocated after policy approval (converged-auto-v1).
