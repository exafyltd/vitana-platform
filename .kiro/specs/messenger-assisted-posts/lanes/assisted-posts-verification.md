---
lane: assisted-posts-verification
state: ready
next_actor: kiro
depends_on: [assisted-posts-data, assisted-posts-service, assisted-posts-invitations, assisted-posts-card-ui]
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
updated: 2026-11-03T13:30Z
---

Read-only staging spec, release checklist, and the acceptance matrix that marks every criterion as mocked,
local-database, read-only staging, or not verified.
