---
lane: assisted-posts-service
state: ready
next_actor: kiro
depends_on: [assisted-posts-data]
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
updated: 2026-11-03T13:30Z
---

Gateway routes under `/api/v1/assisted-posts/*`, the server-side publish path with database idempotency (design §3),
wording through the Bedrock stage, and the feature flag. Reuses the existing post validation, moderation and the
`profile_posts` insert path.
