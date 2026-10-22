---
lane: brand-surface-r2
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/pages/CommerceJoin.tsx
  - src/pages/CommerceJoin.oauth-first.test.ts
  - src/pages/CommerceJoin.routing.test.ts
  - src/components/AuthGuard.tsx
  - src/pages/RedeemVoucher.tsx
  - src/components/voucher/RedemptionLanding.tsx
  - src/lib/store-links.ts
  - src/lib/store-links.test.ts
  - src/hooks/useTenantMeta.ts
  - src/hooks/useTenantMeta.test.ts
  - src/App.tsx
  - src/i18n/de/tenantBrand.json
  - src/i18n/en/tenantBrand.json
  - src/i18n/es/tenantBrand.json
  - src/i18n/sr/tenantBrand.json
  - src/i18n/fr/tenantBrand.json
  - src/i18n/pl/tenantBrand.json
  - src/i18n/pt/tenantBrand.json
  - src/i18n/ru/tenantBrand.json
  - src/i18n/tr/tenantBrand.json
  - src/i18n/zh/tenantBrand.json
  - src/i18n/ar/tenantBrand.json
  - docs/SCREEN_INVENTORY.md
  - tests/e2e/staging/vtid-*-brand-surface.staging.spec.ts
updated: 2026-10-22T11:20Z
---
# brand-surface-r2 — member-facing brand constants tenant-driven, Lane-scope clean (repo vitana-v1)

Plan: `.kiro/specs/mt-frontend-brand-r2/plan.md` and the `brand-surface-r2` section of `tasks.md` (BR1–BR6, allowed
paths, acceptance) are authoritative. Supersedes `mt-frontend-brand/brand-surface` (VTID-05242). VTID: assigned by CI
after PLAN-SPAR converges; do not start before `vtid:` is set here.

Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another lane, no
merge/approve/deploy/dispatch outside §7b, no Supabase/AWS/gateway writes. Work only in the allowed paths;
`docs/validation/<vtid>/` is the lane's own. Reuse the code of `vitana-v1#1485` commits `e31230ac6` / `7a8b2ab74`;
never a `github-actions[bot]` commit (`e7e62ca89`, `3c56f18e1`, `14cdc2adf`). Ship `tenantBrand.json` in all 11 locales
(DE first, du-form) and run the BR3 pre-push gate before every push: stamp drift 0, audit 100.0%, changed files ⊆ paths.
`i18n-source-stamps/**` and `src/i18n/en/screens.json` are deliberately not in paths. Branch
`kiro/mt-frontend-brand-r2/brand-surface-r2`; PR title `VTID-xxxxx (mt-frontend-brand-r2/brand-surface-r2): …`;
trailers `Collab-Session` / `Collab-Lane: mt-frontend-brand-r2/brand-surface-r2`. Deploys (frontend): ships
`docs/validation/<vtid>/staging-tests.json`; done when STAGING-VERIFY passed on its merge commit.
Shared files: none.

## Log
### 2026-10-22T11:20Z · kiro-hotmail-202610212135-3b9f · created → ready
Lane created with the amendment plan. Paths widened vs `brand-surface` by the two CommerceJoin tests, the 9 other
`tenantBrand.json` locales and the staging spec. Next: PLAN-SPAR; once `vtid:` is set, seat exafyltd claims it.
