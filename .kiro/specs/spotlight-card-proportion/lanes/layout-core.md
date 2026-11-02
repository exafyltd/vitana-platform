---
lane: layout-core
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-v1]
paths:
  - src/components/layout/spotlight/SpotlightGrid.tsx
  - src/components/layout/spotlight/ScreenFrame.tsx
  - src/components/layout/spotlight/index.ts
  - src/components/layout/spotlight/spotlight-grid.test.tsx
  - src/components/layout/spotlight/spotlight.vtid-05105.test.tsx
  - src/components/layout/spotlight/skeletons/ArchetypeSkeleton.tsx
  - src/components/layout/spotlight/skeletons/SpotlightLoading.tsx
  - src/components/layout/spotlight/skeletons/SpotlightLoading.test.tsx
  - src/components/ui/vcard/VCard.tsx
  - src/components/ui/vcard/VCard.test.tsx
  - src/i18n/*/spotlight.json
  - i18n-source-stamps/*.json
  - docs/SCREEN_INVENTORY.md
  - docs/design-system/SPOTLIGHT_RULES.md
  - docs/validation/VTID-*/**
  - src/components/spotlight/tier-b/VitanaIndexHeroCard.tsx
  - src/pages/spotlight-tier-b.vtid-05111.test.tsx
  - tests/e2e/staging/vtid-05416-discover-spotlight-grid.staging.spec.ts
  - tests/e2e/staging/vtid-05417-events-spotlight-grid.staging.spec.ts
  - tests/e2e/staging/vtid-05418-find-match-spotlight-grid.staging.spec.ts
  - tests/e2e/staging/vtid-05419-health-spotlight-grid.staging.spec.ts
updated: 2026-11-02T11:27Z
branch: kiro/spotlight-card-proportion/layout-core
vtid: VTID-05420
---
# layout-core — shared SpotlightGrid, ScreenFrame opt-in, VCard Spotlight identity, grid skeletons, SR-26, spotlight.grid i18n keys (repo vitana-v1)
Plan: `.kiro/specs/spotlight-card-proportion/plan.md` and `tasks.md` section `layout-core`. Lands first; the four page lanes depend on its interfaces (plan.md "Interfaces").
**Held until PLAN-SPAR allocates this lane's VTID.** Branch `kiro/spotlight-card-proportion/layout-core`; trailers
`Collab-Session` / `Collab-Lane: spotlight-card-proportion/layout-core`. §7a applies: no VTID by hand, no production
workflow, no live writes, `desktop_spotlight` tenant flag never flipped. `docs/validation/VTID-*/**` means this
lane's own VTID directory only.

## Log
### 2026-10-31T14:00Z · kiro-exafyltd-202610311330-7ae2 · created → ready
Created and held.

### 2026-10-31T23:46Z · ci-plan-spar · ready (VTID allocated)
VTID-05420 allocated after policy approval (converged-auto-v1).

### 2026-11-02T11:27Z · kiro-202610152203-0347 · paths widened (STAGING-VERIFY round-2 fix-forward)
STAGING-VERIFY run 41329713260 failed 52/58 (Spotlight width, flat media, fold overflow). The round-2 fix
(vitana-v1 #1557) touches the Health Spotlight art (`VitanaIndexHeroCard.tsx`), its unit test and the four grid
staging specs written by the page lanes, whose lanes are already merged. Those six paths move to this lane so the
fix lands as one PR. No new behaviour beyond the approved plan.
