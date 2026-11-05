---
lane: assisted-posts-invitations
state: ready
next_actor: kiro
depends_on: [assisted-posts-data, assisted-posts-service]
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
updated: 2026-11-03T13:30Z
---

One new scanner in the existing community-autopilot engine, idempotent invitation delivery through the unique window
key, the pause rule, and the expiry sweep. No second scheduler.
