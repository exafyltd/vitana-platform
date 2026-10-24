---
lane: tenant-switcher-ui
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: frontend
paths:
  - src/components/tenant-switcher/**
  - src/pages/settings/**
  - src/i18n/de/tenantSwitcher.json
  - src/i18n/en/tenantSwitcher.json
  - tests/e2e/staging/vtid-*-tenant-switcher.staging.spec.ts
  - docs/validation/VTID-*/**
  - docs/SCREEN_INVENTORY.md
  - i18n-source-stamps/**
updated: 2026-10-15T16:40Z
---
# Member community switcher — mt-m3 (repo vitana-v1)

Plan: `.kiro/specs/mt-m3/plan.md`; tasks S1–S6 in `tasks.md`; design in `design.md`. A member-facing `CommunitySwitcher`
listing the member's own `user_tenants` memberships and switching via the existing `useTenant().setTenantBySlug`
(`switch_to_tenant_by_slug` RPC + `refreshSession`); hidden for single-tenant members; NOT exafy-admin-gated (that is
`TenantManagement`). Mounted in Settings — no new route, so no nav-registry/manifest/parity change; if a route is added,
add the registry + screen-manifest + parity-ledger rows in this lane. i18n DE-first du-form; Spotlight tokens; RTL. The
lane adds its own `docs/validation/VTID-<vtid>/` (plan-sparring copy, scope.json, staging-tests.json).

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes, and never call a switch endpoint against a live system beyond read-only staging. Work only inside
the allowed paths. Branch `kiro/mt-m3/tenant-switcher-ui`; PR title `VTID-xxxxx (mt-m3/tenant-switcher-ui): …`; trailers
`Collab-Session` / `Collab-Lane: mt-m3/tenant-switcher-ui`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

HELD: `next_actor: owner` until PLAN-SPAR allocates this lane's VTID.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-m3 plan. Held for PLAN-SPAR. Frontend lane, seat `exafyltd` (area `frontend`), reviewer `hotmail`.
