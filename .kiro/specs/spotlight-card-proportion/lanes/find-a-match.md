---
lane: find-a-match
state: ready
next_actor: kiro
depends_on: [layout-core]
executor: kiro
seat: exafyltd
area: frontend
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-v1]
paths:
  - src/pages/community/FindPartner.tsx
  - src/components/community/spotlight/FindMatchSpotlightBody.tsx
  - src/components/community/spotlight/find-match-spotlight.test.tsx
  - src/components/ui/vcard/adapters/match.ts
  - src/components/ui/vcard/adapters/index.ts
  - src/pages/community/social-spotlight-pages.vtid-05110.test.tsx
  - tests/e2e/staging/vtid-*-find-match-spotlight-grid.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-31T14:00Z
branch: kiro/spotlight-card-proportion/find-a-match
---
# find-a-match — Community > Find a Match onto SpotlightGrid (top match + Say hello, six matches, More people row) (repo vitana-v1)
Plan: `.kiro/specs/spotlight-card-proportion/plan.md` and `tasks.md` section `find-a-match`. Starts when `layout-core` is on `main`; independent of the other page lanes.
**Held until PLAN-SPAR allocates this lane's VTID.** Branch `kiro/spotlight-card-proportion/find-a-match`; trailers
`Collab-Session` / `Collab-Lane: spotlight-card-proportion/find-a-match`. §7a applies: no VTID by hand, no production
workflow, no live writes, `desktop_spotlight` tenant flag never flipped. `docs/validation/VTID-*/**` means this
lane's own VTID directory only.

## Log
### 2026-10-31T14:00Z · kiro-exafyltd-202610311330-7ae2 · created → ready
Created and held.