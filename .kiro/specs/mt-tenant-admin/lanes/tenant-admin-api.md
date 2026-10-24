---
lane: tenant-admin-api
state: ready
next_actor: owner
depends_on: [tenant-admin-moderation-db, tenant-lifecycle-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/routes/admin-tenants.ts
  - services/gateway/src/routes/admin-tenants-repository.ts
  - services/gateway/src/routes/admin-signups.ts
  - services/gateway/src/routes/admin-community-marketplace.ts
  - services/gateway/src/routes/admin-moderation.ts
  - services/gateway/src/routes/admin-moderation-repository.ts
  - services/gateway/src/routes/index.ts
  - services/gateway/src/services/tenant-provisioning/**
  - services/gateway/src/middleware/require-tenant-admin.ts
  - services/gateway/src/routes/admin-autopilot.ts
  - services/gateway/src/services/community-marketplace/community-marketplace-repository.ts
  - services/gateway/test/mt-tenant-admin-*.test.ts
updated: 2026-10-20T16:40Z
---
# Tenant-admin gateway API — scoped reads + shared tenant resolver, readiness, lifecycle (repo vitana-platform)

Plan: `.kiro/specs/mt-tenant-admin/plan.md` (authoritative) and the `tenant-admin-api` section of `tasks.md`. Design
and the rules you must follow: `design.md`.

**HELD until PLAN-SPAR allocates the VTID** (`next_actor: owner`, no `vtid`). PLAN-SPAR writes the VTID into this
still-`ready` lane and flips `next_actor` to kiro on a converged plan. Do not self-allocate. **Depends on**
`tenant-admin-moderation-db` and `tenant-lifecycle-db` — this lane wires their RPCs, so build it after they merge.

Scope: the invitation-accept route is OUT of scope — it already exists and is hardened
(`services/gateway/src/routes/tenant-admin/invitations.ts` `acceptRouter`, mounted `index.ts:1433`, VTID-05044); this
lane does NOT create `admin-invitations.ts` and does NOT edit the existing route. This lane adds tenant-scoped
moderation/signups/notifications/users/audit admin reads. **Auth-guard decision (no widening by default): ADD new
`requireTenantAdmin`-guarded endpoints ALONGSIDE the existing exafy-admin-only ones** (`admin-signups.ts:32,62,113,…`
use `requireExafyAdmin`; `admin-moderation.ts:25,51` use inline `verifyExafyAdmin`); do NOT replace those guards
unless the owner approved the widening in the plan's `## Owner decisions`. Each new scoped read derives the tenant
from `req.targetTenantId` for a tenant-admin (resolved by `requireTenantAdmin`, `require-tenant-admin.ts:102,159`) AND
**branches on `req.identity.exafy_admin` to omit the tenant filter** — the middleware returns at
`require-tenant-admin.ts:96` before setting `targetTenantId`, so for an exafy-admin `req.targetTenantId` is unset and a
bare `targetTenantId || req.identity.tenant_id` (the `admin-autopilot.ts:23-24` pattern) silently scopes them to their
own tenant. **Shared resolvers (REQUIRED):** export `resolveScopedTenant(req)` (list reads: `{scope:'all'}` for an
exafy-admin, else `{scope:'tenant', tenantId}`) and `resolveSingleTenant(req)` (single-tenant config:
`targetTenantId`, or `params.tenantId || identity.tenant_id` for an exafy-admin) from `require-tenant-admin.ts`; every
scoped handler uses only these, and `test/mt-tenant-admin-scope-helper.test.ts` fails on a direct
`identity.tenant_id` / `identity?.tenant_id` / `targetTenantId` read in the lane's listed files. **Backfill:**
`admin-autopilot.ts:23-24` → `resolveSingleTenant` (same result); `admin-community-marketplace.ts:30-31` →
`resolveScopedTenant` on `/listings` (cross-tenant for an exafy-admin only with `MT_RESOLUTION_V2` on; repository
`.eq` skipped for `null`) and `resolveSingleTenant` on writes (unchanged); its `emitAdminActivity` (`:37-53`) takes
`tenantId` as a parameter instead of the `:50` local read (payload unchanged). `/admin/init-events` is NOT in this lane:
the page is guarded at its existing path in `tenant-admin-pages` and `e2e/fixtures/routes.ts` is not edited.
Extend `GET /admin/tenants/:id/readiness` with first-admin-invitation delivery + lifecycle; expose exafy-admin
deactivate/archive routes over the lifecycle RPCs, each emitting OASIS `tenant.deactivated` / `tenant.archived` via the
`admin-tenants.ts:301` `emit()` parameterised with a `vtid` argument (default `PROVISION_VTID`, `:193`) and called with
this lane's `LIFECYCLE_VTID` (Jest asserts the vtid), and define the deactivated-tenant gateway posture (O2). Dark behind
`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`. The lane adds its own `docs/validation/<vtid>/` in the PR.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, and never call a write endpoint against any live
system (staging tests read-only, rule 48). Work only inside the allowed paths. Branch
`kiro/mt-tenant-admin/tenant-admin-api`; PR title `VTID-xxxxx (mt-tenant-admin/tenant-admin-api): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-tenant-admin/tenant-admin-api`. When the PR is open: set
`state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-* program planner (session kiro-hotmail-202610151618-b437, holding `mt-tenant-admin/_plan`). Gateway
code lane, seat `jtadic` (platform gateway work per areas.yaml uncovered-work rule), reviewer seat `hotmail` (≠ seat).
Separate from the DB lanes per §4.7. Held for PLAN-SPAR VTID allocation.

### 2026-10-18T00:00Z · kiro-hotmail-202610151618-b437 · sparring round (s2-r1) — scope clarified (no path change)
PLAN-SPAR findings R1-F2 + R1-F3 (both major). F2: `require-tenant-admin.ts:96` returns before `:159`, so
`req.targetTenantId` is unset for an exafy-admin and the `admin-autopilot.ts:23-24` `targetTenantId || tenant_id`
pattern would silently scope an exafy-admin to their own tenant — the lane now requires an explicit
`req.identity.exafy_admin` branch in every scoped read, with a Vitest asserting the cross-tenant view (A6). F3: the
current reads are exafy-admin-only (`admin-signups.ts requireExafyAdmin`, `admin-moderation.ts verifyExafyAdmin`); the
lane ADDS new `requireTenantAdmin` endpoints beside them rather than replacing the guards (no widening), any widening
held for owner approval. No `paths` change.

### 2026-10-20T16:40Z · kiro-hotmail-202610151618-b437 · sparring session 2 round 1 (new session 03698d49) — paths changed
PLAN-SPAR R1-F1..F5. Added OASIS `tenant.deactivated`/`tenant.archived` emits (F1); shared `resolveScopedTenant`/`resolveSingleTenant` in `require-tenant-admin.ts` + scope-helper guard test (F2); backfill of `admin-autopilot.ts` and `admin-community-marketplace.ts` onto the helpers (F4, listings cross-tenant only behind `MT_RESOLUTION_V2`); `/admin/init-events` handled entirely in `tenant-admin-pages` (guard at existing path), so `e2e/fixtures/routes.ts` dropped from `paths` (F3); mount citation `index.ts:1433` (F5). `paths` + `require-tenant-admin.ts`, `admin-autopilot.ts`, `community-marketplace-repository.ts`; − `e2e/fixtures/routes.ts`.
