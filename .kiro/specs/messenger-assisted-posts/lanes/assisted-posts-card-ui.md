---
lane: assisted-posts-card-ui
state: ready
next_actor: kiro
depends_on: [assisted-posts-service]
executor: kiro
seat: exafyltd
area: messenger
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
updated: 2026-11-03T13:30Z
---

The "Make a Post" invitation card, the photo/video and text composer, the preview, the success state, and the
localized copy (de first, en mirrored). Reuses the card registry, the composer upload pieces and the analytics batch.
