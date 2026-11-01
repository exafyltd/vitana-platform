---
lane: work-surface-permission
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/orb/profile/assistant-profile.ts
  - services/gateway/src/orb/live/session/live-session-controller.ts
  - services/gateway/src/routes/orb-livekit.ts
  - services/gateway/src/routes/conversation.ts
  - services/gateway/test/mt-track-s-authz-work-surface.test.ts
  - docs/validation/**
updated: 2026-11-01T20:10Z
---
# Lane: work-surface-permission (repo vitana-platform)
Tasks in `tasks.md`. A declared ORB work surface is served only to a caller with a permitted role for it (else the
member surface), on the Vertex/Nova and LiveKit paths; the text path uses a privileged body role only when verified.
VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-01T20:10Z · kiro-202611011939-b712 · ready
Lane created with the plan.
