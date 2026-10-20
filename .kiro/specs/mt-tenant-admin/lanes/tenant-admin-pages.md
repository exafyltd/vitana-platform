---
lane: tenant-admin-pages
state: ready
next_actor: owner
depends_on: [tenant-admin-api]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: jtadic
paths:
  - src/pages/admin/InvitationAccept.tsx
  - src/pages/admin/tenant-admin/**
  - src/components/admin/tenant-admin/**
  - src/lib/tenant-admin-api.ts
  - src/lib/tenant-admin-api.test.ts
  - src/App.tsx
  - src/i18n/de/tenantAdmin.json
  - src/i18n/en/tenantAdmin.json
  - src/navigation/registry/screens.json
  - src/navigation/registry/exclusions.json
  - apps/mobile/parity/ledger.json
  - tests/e2e/staging/mt-tenant-admin-*.staging.spec.ts
  - docs/SCREEN_INVENTORY.md
  - i18n-source-stamps/**
updated: 2026-10-15T16:18Z
---
# Tenant-admin pages + invitation accept — vitana-v1 (repo vitana-v1)

Plan: `.kiro/specs/mt-tenant-admin/plan.md` (authoritative) and the `tenant-admin-pages` section of `tasks.md`. Design
and the rules you must follow: `design.md`.

**HELD until PLAN-SPAR allocates the VTID** (`next_actor: owner`, no `vtid`). PLAN-SPAR writes the VTID in and flips
`next_actor` to kiro on a converged plan. Do not self-allocate. **Depends on** `tenant-admin-api` (consumes its
tenant-scoped admin reads). The accept endpoint it POSTs to already exists in production (VTID-05044,
`services/gateway/src/routes/tenant-admin/invitations.ts`), independent of the `tenant-admin-api` lane.

Two things merged into one vitana-v1 frontend lane (same repo + seat + compatible order, CROSS-SPEC lane-count merge
rule): (1) the **invitation accept page OUTSIDE the admin guard** — a new `/admin/invitations/accept/:token` route
whose component is NOT behind the admin `RouteGuard`, matching the `accept_path` the gateway already returns
(`services/gateway/src/routes/admin-tenants.ts:371`). It POSTs the token to the EXISTING, hardened accept route
(`routes/tenant-admin/invitations.ts`, VTID-05044) and surfaces that route's outcomes — 403 `EMAIL_UNVERIFIED`/
`EMAIL_MISMATCH`, 409 `INVITATION_ROLES_INVALID`/`ALREADY_USED`, 410 `EXPIRED`, and the granted roles on success — in
i18n'd copy. The page enforces nothing itself and shows only the roles the route reports granted (the email-match +
role-allowlist enforcement lives in the route already; mt-track-s adds a second, auth-layer line of defence).
(2) the **scoped tenant-admin pages** (moderation, signups, notifications, users, audit) consuming the
tenant-scoped gateway reads. This lane also **governs the `/admin/init-events` frontend route**
(`src/pages/admin/InitEvents.tsx`, a static dev helper that calls no gateway endpoint): mount it in `App.tsx` under
the admin `RouteGuard` at its existing path `/admin/init-events`, as the other `/admin/*` pages are (guard, never
remove). The gateway fixture entry (`e2e/fixtures/routes.ts:193`, `ADMIN_ROUTES`) already lists it as admin-only and is
NOT edited, so this lane is the only change for that route. **A new App.tsx route also needs its `screens.json`/`exclusions.json` row, its
`SCREEN_INVENTORY.md` entry (`npm run i18n:inventory`) and its `apps/mobile/parity/ledger.json` row
(`node scripts/native/parity-ledger.mjs --sync`)** — `npm test` fails otherwise. Spotlight tokens only, logical
start/end, skeletons; i18n DE-first du-form (`src/i18n/de/tenantAdmin.json` first, mirror to `en/`); RTL via logical
properties. No What's New entry (admin-only, not a member feature). The lane adds its own `docs/validation/<vtid>/` in
the PR.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, and never call a write endpoint against any live
system (staging specs read-only with a non-GET network guard, rule 48). Work only inside the allowed paths. Branch
`kiro/mt-tenant-admin/tenant-admin-pages`; PR title `VTID-xxxxx (mt-tenant-admin/tenant-admin-pages): …`; commit
trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-tenant-admin/tenant-admin-pages`. When the PR
is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-* program planner (session kiro-hotmail-202610151618-b437, holding `mt-tenant-admin/_plan`). vitana-v1
`src/**` → area `frontend` → seat `exafyltd` (areas.yaml catch-all); reviewer seat `jtadic` (≠ seat). Accept-UI and
scoped-admin-pages merged into one lane (same repo+seat, compatible order) per the lane-count merge rule. Held for
PLAN-SPAR VTID allocation.
