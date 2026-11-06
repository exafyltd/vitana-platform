# Requirements — mt-tenant-admin (spec 07) — mt-tenant-admin-r2 (re-plan)

Program: `docs/MULTI-TENANT-PLAN.md` (v5.1, owner-approved 2026-10-10) §6 WS4. This spec is the Kiro-readable hand-off
of the WS4 rest; it links the program's records instead of copying them.

## Program position
- **Predecessors (DONE, in production):** S-M VTID-05147, A VTID-05149, B VTID-05150 (`provision_tenant()`, exafy-admin
  `admin-tenants` API, `tenant_invitations` first-admin row, assets, readiness), C VTID-05151 (public registry,
  DB-driven `useTenant`). Records: `docs/validation/VTID-0514{7,9}/`, `docs/validation/VTID-0515{0,1}/`,
  `docs/multitenancy/MIGRATION-QUEUE.md`, `docs/multitenancy/LANE-C.md`.
- **Peers / successors:** mt-community-isolation-r2 (reserves C3 migration `20261102070160`), mt-track-s-r2 (adds the S-G
  invitation security enforcement at the AUTH LAYER as a second line of defence; the application-layer email-match +
  role-allowlist already live in the accept route, VTID-05044), mt-m3 (references O2, owns the offboarding runbook),
  mt-packs (WS5 content/assistant packs — out of scope here).

## This spec (WS4 rest)

### R1 — Invitation accept PAGE outside the admin guard (lane `tenant-admin-pages`)
The gateway accept route already exists and is hardened (VTID-05044, `services/gateway/src/routes/tenant-admin/
invitations.ts` `acceptRouter`, mounted at `/api/v1/admin/invitations` in `index.ts:1433`); this spec adds only the
frontend page that consumes it and introduces no new gateway accept route and no application-layer enforcement.
1. THE SYSTEM SHALL serve a frontend invitation-accept page at `/admin/invitations/accept/:token` that is NOT behind
   the admin `RouteGuard` (an invited first admin is not yet an admin), POSTing the token to the existing
   `POST /api/v1/admin/invitations/accept/:token` that `provision_tenant()`'s `accept_path` already points at
   (`services/gateway/src/routes/admin-tenants.ts:371`).
2. WHEN the existing route refuses on a confirmed-email/email-match failure (403 `EMAIL_UNVERIFIED`/`EMAIL_MISMATCH`,
   `invitations.ts:208-233`) THE PAGE SHALL surface that outcome in user-readable, i18n'd copy.
3. WHEN the route grants only the allowlisted roles (it re-checks `roles[]` and refuses unknown/super-admin-only roles,
   409 `INVITATION_ROLES_INVALID`, `invitations.ts:237-268`) THE PAGE SHALL display only those granted roles; the page
   performs no role filtering of its own.
4. WHEN the route answers 410 (expired, `:200`) or 409 (already used, `:289-299`) THE PAGE SHALL explain the outcome.

### R2 — Scoped tenant-admin surfaces (lanes `tenant-admin-api`, `tenant-admin-pages`)
1. EVERY tenant-admin read (moderation, signups, notifications, users, audit) SHALL return only the tenant resolved by
   `requireTenantAdmin` — `req.targetTenantId` (the caller's own tenant is `req.identity.tenant_id`,
   `require-tenant-admin.ts:102,159`) — keeping the exafy-admin super-admin bypass the middleware already provides
   (`require-tenant-admin.ts:96`), so an exafy-admin still sees all tenants on list reads.
3. EVERY such handler SHALL read the tenant only through the shared resolvers `resolveScopedTenant` /
   `resolveSingleTenant` exported from `require-tenant-admin.ts`; a guard test SHALL fail on a direct
   `identity.tenant_id` / `targetTenantId` read in the lane's files. The existing `admin-autopilot.ts` and
   `admin-community-marketplace.ts` locals SHALL be moved onto them (autopilot unchanged; the listings queue
   cross-tenant for an exafy-admin only behind `MT_RESOLUTION_V2`).
2. A tenant admin of tenant B SHALL see zero tenant-A rows on every scoped surface (contract test: no `CANARY_A`).

### R3 — `/admin/init-events` governed (lane `tenant-admin-pages`)
1. THE SYSTEM SHALL guard the `/admin/init-events` **frontend route** (`vitana-v1/src/pages/admin/InitEvents.tsx`)
   behind the admin `RouteGuard` in `vitana-v1/src/App.tsx` at its existing path (guard, never remove; lane
   `tenant-admin-pages`). It is a frontend dev helper that calls no gateway endpoint, so there is no gateway route to
   guard.
2. THE gateway e2e fixture entry (`e2e/fixtures/routes.ts:193`, `ADMIN_ROUTES`) already lists the route as admin-only
   and SHALL stay unchanged, so the change lands in one repo and one PR.

### R4 — Deactivate / archive (lanes `tenant-lifecycle-db`, `tenant-admin-api`) — cross-spec O2
1. THE SYSTEM SHALL provide `deactivate_tenant(slug)` and `archive_tenant(slug)` RPCs, idempotent, expand/contract,
   with a pre-approved rollback.
2. WHEN a tenant is deactivated THE SYSTEM SHALL resolve its members to the default tenant (never a hard lockout) via
   the closing switch RPC; a deactivated tenant SHALL be excluded from switch targets (already true at
   `admin-tenants.ts:253`).
3. THE gateway SHALL define the deactivated-tenant API posture (member sessions resolve to default; exafy-admin reads
   of the deactivated tenant still work for archival).
4. WHEN a tenant is deactivated or archived THE gateway SHALL emit the OASIS event `tenant.deactivated` /
   `tenant.archived` (same `emit()` as `tenant.provisioned`, `admin-tenants.ts:301,353`), attributed to this spec's
   VTID — not the provisioning `PROVISION_VTID` (`:193`).

### R5 — Command Hub tenant module (lane `command-hub-tenant-module`)
1. THE SYSTEM SHALL add a NEW Command Hub module (`tenant-admin.js`, `kind:"module"`) exposing
   `window.TenantAdmin.render()`, registered in `modules.json` + `index.html`, with `app.js` changed by at most one
   render-switch case line. CSP: external JS only, no inline script/style. exafy-admin only + server-gated.

### R6 — Readiness + first-admin invitation delivery (lanes `tenant-admin-api`, `command-hub-tenant-module`)
1. THE SYSTEM SHALL extend `GET /admin/tenants/:id/readiness` with first-admin-invitation delivery state and lifecycle
   (active/deactivated), and the Command Hub module SHALL surface it and allow re-delivery of the first-admin invite.

### Cross-cutting
- Dark by default (`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`); exception named: the exafy-admin-only
  Command Hub module. Migrations applied by Kiro via RUN-MIGRATION, only on the owner's approval of the files and the target database (§7d) after merge (owner-approved). Never test against
  production; staging tests read-only (rule 48). i18n DE-first du-form + RTL; Spotlight contract; WCAG 2.2 AA.

## Not in this slice
The gateway accept route (ALREADY built and hardened, VTID-05044); the S-G auth-layer enforcement itself
(mt-track-s, a second line of defence); provisioning core (B/C, DONE); community isolation C3
(mt-community-isolation); access-token auth hook (D14, WS1); native app (WS9); tenant-owner analytics (WS8);
content/assistant packs (WS5); custom domains. Each later slice is sparred and approved on its own.
