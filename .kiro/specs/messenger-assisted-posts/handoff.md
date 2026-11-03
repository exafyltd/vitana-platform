---
slug: messenger-assisted-posts
author: kiro
author_seat: exafy
executor: kiro
next_actor: claude
state: parked
updated: 2026-11-03T16:00Z
parked_from: drafted
---

Assisted posting inside the Vitana Messenger conversation: a member receives a "Make a Post" invitation, chooses one
photo or one video (or writes a text post), reviews an AI-assisted and editable preview, and publishes to News Feed
after an explicit confirmation. Feature flag `FEATURE_ASSISTED_POSTS_ENV`, off in production.

Owner decisions taken in this conversation (2026-11-03): V1 media is one photo or one video plus text; audience is
Public only; server-side publication with database idempotency; verification is automated tests plus read-only staging
checks; migrations are approved by the owner before they touch the shared database.

### 2026-11-03T13:30Z · kiro-exafy-202611031304-5f5a · drafted
Created the planning spec: requirements, design, tasks (five lanes), plan, and five lane files (all `ready`, path-free
until executing). Next: push `plan(messenger-assisted-posts)` so CI PLAN-SPAR spars it. Sparring responses are answered
in `sparring/responses-<n>.md`. VTIDs come only from CI policy approval.

### 2026-11-03T16:00Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (evidence_floor_not_met). Parked with the open findings in sparring/.
