---
lane: card-actions
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
area: frontend
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-v1]
paths:
  - src/components/home/CommunityPostCard.tsx
  - src/components/home/CommunityPostCard.test.tsx
  - tests/e2e/staging/vtid-*-news-feed-post-action-row.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-11-19T12:10Z
---
# News Feed post card — author row on top, actions on their own row (vitana-v1)
Plan: `.kiro/specs/news-feed-post-action-row/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: card-actions -->` (L1–L4) are authoritative.

**Acceptance (reviewer agent):** see `tasks.md` lane `card-actions`.

**Never** (collaboration §7a): no VTID allocation by hand, no merge except §7b, no production deploy, no writes to
Supabase/AWS/storage, no test against production; the staging spec is read-only.

## Log
### 2026-11-19T12:10Z · kiro-jtadic-202611191143-e223 · created → ready
Lane created with the plan. One source file and its test; the staging spec and evidence folder are new files.
