---
lane: card-layout
state: in-review
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
updated: 2026-10-22T09:40Z
claimed_by: kiro-exafyltd-202610220818-5273
branch: kiro/profile-posts-full-width/card-layout
pr: https://github.com/exafyltd/vitana-v1/pull/1489
vtid: VTID-05330
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

### 2026-10-22T08:46Z · ci-plan-spar · ready (VTID allocated)
VTID-05330 allocated after policy approval (converged-auto-v1).

### 2026-10-22T09:40Z · kiro-exafyltd-202610220818-5273 · ready → executing → in-review
Claimed the lane. Built L1–L5 in exafyltd/vitana-v1#1489 (branch `kiro/profile-posts-full-width/card-layout`):
test first (`753ee8e06`, 4/4 red on main), fix (`526979d9b`), merge of origin/main keeping the colour-token
migration on the moved lines (`14a1bdc47`). Local: layout test 4/4, `src/components/profile` 16 files / 87 tests,
`npm run build`, `npm run test:design-contract` green, no new ESLint error. Screenshots 390×844 / 1400×900 in
`docs/validation/VTID-05330/screenshots/` (phone text x 93→37, media 260→356 px; desktop identical to main).
Next: reviewer agent `vitana-lane-reviewer` reviews the PR head; then land under §7b.
