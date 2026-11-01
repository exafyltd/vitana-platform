---
lane: events
state: in-review
next_actor: kiro
depends_on: [layout-core]
executor: kiro
seat: exafyltd
area: frontend
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-v1]
paths:
  - src/pages/community/EventsAndMeetups.tsx
  - src/components/community/spotlight/EventsSpotlightBody.tsx
  - src/components/community/spotlight/social-spotlight.vtid-05110.test.tsx
  - tests/e2e/staging/vtid-05110-social-spotlight.staging.spec.ts
  - tests/e2e/staging/vtid-*-events-spotlight-grid.staging.spec.ts
  - docs/validation/VTID-*/**
claimed_by: kiro-exafyltd-202610311330-7ae2
pr: https://github.com/exafyltd/vitana-v1/pull/1535
updated: 2026-11-01T11:49Z
branch: kiro/spotlight-card-proportion/events
vtid: VTID-05417
---
# events — Community > Events & MeetUps onto SpotlightGrid (next big event + Join, this week 3x2, Upcoming row) (repo vitana-v1)
Plan: `.kiro/specs/spotlight-card-proportion/plan.md` and `tasks.md` section `events`. Starts when `layout-core` is on `main`; independent of the other page lanes.
**Held until PLAN-SPAR allocates this lane's VTID.** Branch `kiro/spotlight-card-proportion/events`; trailers
`Collab-Session` / `Collab-Lane: spotlight-card-proportion/events`. §7a applies: no VTID by hand, no production
workflow, no live writes, `desktop_spotlight` tenant flag never flipped. `docs/validation/VTID-*/**` means this
lane's own VTID directory only.

## Log
### 2026-10-31T14:00Z · kiro-exafyltd-202610311330-7ae2 · created → ready
Created and held.

### 2026-10-31T23:46Z · ci-plan-spar · ready (VTID allocated)
VTID-05417 allocated after policy approval (converged-auto-v1).

### 2026-11-01T11:35Z · kiro-exafyltd-202610311330-7ae2 · ready → executing
Claimed (claim ref commit ec5a53be). Built once `layout-core` landed on vitana-v1 `main` (3ac1f5bb8, 11:02:47Z).

### 2026-11-01T11:49Z · kiro-exafyltd-202610311330-7ae2 · executing → in-review
PR: https://github.com/exafyltd/vitana-v1/pull/1535, head 8581372d210f1756f115582c62c3b30405ca6031. Red on base 3ac1f5bb8 (6 failed, 17 passed); head social-spotlight.vtid-05110 23/23; build ok; ESLint 0 new. Evidence in vitana-v1 `docs/validation/VTID-05417/`.
Next: agent:vitana-lane-reviewer reviews the PR head.
