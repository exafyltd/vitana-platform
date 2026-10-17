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
  - services/gateway/test/mt-tenant-admin-*.test.ts
  - e2e/fixtures/routes.ts
updated: 2026-10-15T16:18Z
---
# Tenant-admin gateway API — accept, scoped reads, init-events, readiness, lifecycle (repo vitana-platform)

Plan: `.kiro/specs/mt-tenant-admin/plan.md` (authoritative) and the `tenant-admin-api` section of `tasks.md`. Design
and the rules you must follow: `design.md`.

**HELD until PLAN-SPAR allocates the VTID** (`next_actor: owner`, no `vtid`). PLAN-SPAR writes the VTID into this
still-`ready` lane and flips `next_actor` to kiro on a converged plan. Do not self-allocate. **Depends on**
`tenant-admin-moderation-db` and `tenant-lifecycle-db` — this lane wires their RPCs, so build it after they merge.

Scope: the invitation-accept route is OUT of scope — it already exists and is hardened
(`services/gateway/src/routes/tenant-admin/invitations.ts` `acceptRouter`, mounted `index.ts:1429`, VTID-05044); this
lane does NOT create `admin-invitations.ts` and does NOT edit the existing route. This lane: tenant-scopes every
moderation/signups/notifications/users/audit admin read by `req.targetTenantId` (resolved by `requireTenantAdmin`,
`require-tenant-admin.ts:102,160`;
the caller's own tenant is `req.identity.tenant_id`) keeping the exafy-admin bypass the middleware already provides
(`:97-99`) — there is NO exported `getTenantId(req)` helper, do not call one; update the `/admin/init-events` entry in
`e2e/fixtures/routes.ts` (`ADMIN_ROUTES`) so the route-inventory test stays green AFTER the `tenant-admin-pages` lane
guards or removes that FRONTEND route (there is no gateway `admin-init-events.ts` route — it is a vitana-v1 React page);
extend `GET /admin/tenants/:id/readiness` with first-admin-invitation delivery + lifecycle; expose exafy-admin
deactivate/archive routes over the lifecycle RPCs and define the deactivated-tenant gateway posture (O2). Dark behind
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
