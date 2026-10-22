---
lane: card-layout
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/components/profile/shared/tabs/ProfilePostsTab.tsx
  - src/components/profile/shared/tabs/ProfilePostsTab.*.test.tsx
  - tests/e2e/staging/vtid-*-profile-posts-full-width.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-22T08:40Z
---
# Profile Posts tab card — avatar header on top, post full width (vitana-v1)
Plan: `.kiro/specs/profile-posts-full-width/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: card-layout -->` (L1–L5) are authoritative.

**Acceptance (reviewer agent):** see `tasks.md` lane `card-layout`.

**Never** (collaboration §7a): no VTID allocation, no merge except §7b, no workflow dispatch or deploy, no writes to
Supabase/AWS/storage, no test against production; the staging spec is read-only.

## Log
### 2026-10-22T08:40Z · kiro-exafyltd-202610220818-5273 · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Next: PLAN-SPAR spars the plan; once CI writes the
VTID here, seat `exafyltd` claims the lane.
