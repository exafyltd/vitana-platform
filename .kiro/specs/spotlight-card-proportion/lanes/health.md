---
lane: health
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
  - src/pages/Health.tsx
  - src/components/spotlight/tier-b/VitanaIndexHeroCard.tsx
  - src/components/spotlight/tier-b/HealthGridTiles.tsx
  - src/components/spotlight/tier-b/health-grid.test.tsx
  - src/pages/spotlight-tier-b.vtid-05111.test.tsx
  - tests/e2e/staging/vtid-*-health-spotlight-grid.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-31T14:00Z
branch: kiro/spotlight-card-proportion/health
---
# health — /health onto SpotlightGrid (Vitana Index Spotlight + six health tiles + Up next row) (repo vitana-v1)
Plan: `.kiro/specs/spotlight-card-proportion/plan.md` and `tasks.md` section `health`. Starts when `layout-core` is on `main`; independent of the other page lanes.
**Held until PLAN-SPAR allocates this lane's VTID.** Branch `kiro/spotlight-card-proportion/health`; trailers
`Collab-Session` / `Collab-Lane: spotlight-card-proportion/health`. §7a applies: no VTID by hand, no production
workflow, no live writes, `desktop_spotlight` tenant flag never flipped. `docs/validation/VTID-*/**` means this
lane's own VTID directory only.

## Log
### 2026-10-31T14:00Z · kiro-exafyltd-202610311330-7ae2 · created → ready
Created and held.