---
lane: tenant-switcher-ui
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
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
updated: 2026-11-01T15:43Z
repos: [exafyltd/vitana-v1]
---
# Member community switcher — mt-m3 (repo vitana-v1)

Plan: `.kiro/specs/mt-m3-r2/plan.md`; tasks S1–S6 in `tasks.md`; design in `design.md`. A member-facing `CommunitySwitcher`
listing the member's own `user_tenants` memberships and switching via the existing `useTenant().setTenantBySlug`
(`switch_to_tenant_by_slug` RPC + `refreshSession`); hidden for single-tenant members; NOT exafy-admin-gated (that is
`TenantManagement`). Mounted in Settings — no new route, so no nav-registry/manifest/parity change; if a route is added,
add the registry + screen-manifest + parity-ledger rows in this lane. i18n DE-first du-form; Spotlight tokens; RTL. The
lane adds its own `docs/validation/VTID-<vtid>/` (plan-sparring copy, scope.json, staging-tests.json).

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes, and never call a switch endpoint against a live system beyond read-only staging. Work only inside
the allowed paths. Branch `kiro/mt-m3-r2/tenant-switcher-ui`; PR title `VTID-xxxxx (mt-m3-r2/tenant-switcher-ui): …`; trailers
`Collab-Session` / `Collab-Lane: mt-m3-r2/tenant-switcher-ui`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.


## Log
### 2026-11-01T15:43Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-m3/tenant-switcher-ui`. Versions day-shifted to `20261102140*`. Executor and reviewer follow today's §3a/§7 rules.
