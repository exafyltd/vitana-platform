---
lane: discover
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
  - src/pages/Discover.tsx
  - src/components/discover/spotlight/DiscoverStorefront.tsx
  - src/components/discover/spotlight/DiscoverCards.tsx
  - src/components/discover/spotlight/storefront-model.ts
  - src/components/discover/spotlight/discover-storefront.vtid-05109.test.tsx
  - tests/e2e/staging/vtid-05109-discover-storefront.staging.spec.ts
  - tests/e2e/staging/vtid-*-discover-spotlight-grid.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-10-31T14:00Z
branch: kiro/spotlight-card-proportion/discover
---
# discover — /discover onto SpotlightGrid (top product Spotlight + six products + Browse categories row) (repo vitana-v1)
Plan: `.kiro/specs/spotlight-card-proportion/plan.md` and `tasks.md` section `discover`. Starts when `layout-core` is on `main`; independent of the other page lanes.
**Held until PLAN-SPAR allocates this lane's VTID.** Branch `kiro/spotlight-card-proportion/discover`; trailers
`Collab-Session` / `Collab-Lane: spotlight-card-proportion/discover`. §7a applies: no VTID by hand, no production
workflow, no live writes, `desktop_spotlight` tenant flag never flipped. `docs/validation/VTID-*/**` means this
lane's own VTID directory only.

## Log
### 2026-10-31T14:00Z · kiro-exafyltd-202610311330-7ae2 · created → ready
Created and held.