# Design — mt-tenant-admin (spec 07)

## What exists (read these, do not copy them)
- Program plan + decision register: `docs/MULTI-TENANT-PLAN.md` (§6 WS4).
- Migration order, lane version ranges, apply status: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Provisioning API (DONE, build on it): `services/gateway/src/routes/admin-tenants.ts` — GET `/` (77), GET `/:id`
  (128), POST `/` (318), PATCH `/:id` (389), PUT `/:id/assets/:kind` (474), GET `/:id/readiness` (536);
  `verifyExafyAdmin` (52) → 403 `FORBIDDEN`; switch-target set already excludes `is_active === false` /
  `is_platform === true` (253). Repository: `admin-tenants-repository.ts` (`fetchAcceptedAdminInvitation` 111).
- First-admin invitation: `provision_tenant()` mints/reuses a `tenant_invitations` row
  (`supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:212-222`); the POST response returns
  `accept_path:/admin/invitations/accept/<token>` (`admin-tenants.ts:371`). Table + flow intent:
  `supabase/migrations/20260412000000_tenant_invitations.sql` (`token`, `roles[]`, `email`, `accepted_at`,
  `revoked_at`, `expires_at`; header L5-7 documents accept → grant roles).
- **Invitation accept route (DONE — VTID-05044, build the page on it, do NOT re-create it):**
  `services/gateway/src/routes/tenant-admin/invitations.ts` exports `acceptRouter`
  (`acceptRouter.post('/accept/:token', requireAuth, …)`, `:186`), mounted at `/api/v1/admin/invitations`
  (`index.ts:503,1433`). It already enforces confirmed-email + email-match (403 `EMAIL_UNVERIFIED`/`EMAIL_MISMATCH`,
  `:208-233`), role allowlist re-check incl. super-admin-only refusal (409 `INVITATION_ROLES_INVALID`, `:237-268`),
  expiry (410 `EXPIRED`, `:200`), atomic claim-before-grant (409 `ALREADY_USED`, `:289-299`), and grants only the
  validated roles (`upsertUserPermittedRole`, `:312-319`). Repository: `services/gateway/src/services/tenant-invitations/
  tenant-invitations-repository.ts`. There is NO `admin-invitations.ts` and this spec creates none.
- Tenant-admin gate: `services/gateway/src/middleware/require-tenant-admin.ts` (`requireTenantAdmin`): Step 2 bypasses
  for exafy-admin (`:96-99`); otherwise it resolves the target tenant `req.params.tenantId || req.identity.tenant_id`
  (`:102`), rejects a cross-tenant mismatch (`:114`), requires `active_role='admin'` + a permitted admin role, and
  attaches `req.targetTenantId` (`:159`) for the handler. The exafy-admin bypass returns at `:96` BEFORE `:159`, so
  `req.targetTenantId` is unset for an exafy-admin. There is **no exported tenant helper today** — this spec adds
  `resolveScopedTenant` / `resolveSingleTenant` to `require-tenant-admin.ts` (lane `tenant-admin-api`). Only per-file
  locals exist: `admin-autopilot.ts:23-24` (`targetTenantId || identity.tenant_id`), `admin-community-marketplace.ts:30-31`
  (`identity.tenant_id`), `admin-marketplace.ts:31`. `admin-autopilot.ts:4-6` confirms the gate serves both
  exafy-admin and tenant-admin.
- OASIS events: `admin-tenants.ts:301` local `emit()` over `emitOasisEvent` (`:24`), used by `tenant.provisioned`
  (`:353-359`), `tenant.brand_pack.updated` (`:455`), `tenant.asset.uploaded` (`:520`).
- `/admin/init-events`: a vitana-v1 **frontend** React page (`vitana-v1/src/pages/admin/InitEvents.tsx`, static dev
  helper, no gateway call, not currently routed in `App.tsx`); present in the gateway e2e route fixture
  `e2e/fixtures/routes.ts:193` under `ADMIN_ROUTES` (`:148`), visited only by admin-role smoke specs (`:391`).
- Command Hub module system: `services/gateway/src/frontend/command-hub/modules.json` (ordered list, `kind` of
  `module`/`extracted`/`app`/`post_app`) + `index.html` script tags. Pattern to follow: `loops-catalog.js` defines
  `window.LoopsCatalog`, `app.js` calls `render()` from its render switch (`loops-catalog.js:12-15`). CSP: no inline
  JS, every node via `textContent`, fetches through `buildContextHeaders()`.
- Frontend: `vitana-v1/src/hooks/useTenant.tsx` (`isExafyAdmin`), `src/lib/admin-api.ts` (`adminFetch`, JSON, sends
  only `Authorization`), the admin `RouteGuard` in `src/App.tsx`, `src/pages/portals/TenantPortal.tsx`.

## tenant-admin-moderation-db (O4)
P2 (`20261101070100`) and P3 (`20261101070150`) add the moderation RPCs/triggers; moderator-tenant-scope
(`20261101070600`) adds the predicate restricting a moderator to their own tenant's reports. mt-community-isolation
C3 is reserved at `070160` — these files sort around it. Each migration has a paired rollback in
`docs/validation/<vtid>/`, read-only pre/post checks, and a MIGRATION-QUEUE row in the same PR. Expand/contract only;
`lock_timeout` + retries; snapshot before any data move; a not-yet-live table goes in `migration-drift-baseline.json`
and is removed after apply.

## tenant-lifecycle-db (O2)
`deactivate_tenant(slug)` sets `tenants.is_active = false`; `archive_tenant(slug)` marks it archived. The **closing
switch RPC** change: when a member's active tenant is deactivated, resolution falls back to the member's default
tenant (`tenants.is_default`), never a hard lockout — consistent with §4 "unresolved → reject, never oldest-tenant"
(a deactivated-but-member tenant resolves to default). pgTAP pins: idempotent RPCs; a deactivated tenant's member
resolves to default; exafy-admin can still read it; rollback restores prior state. Migrations `070300`/`070350` with
rollbacks + pre/post checks + queue rows.

## tenant-admin-api
- **No accept-route work.** The `POST /admin/invitations/accept/:token` route already exists and is hardened (VTID-05044,
  `routes/tenant-admin/invitations.ts`, see "What exists"). This lane neither creates `admin-invitations.ts` nor edits
  the existing route. The application-layer email-match + role-allowlist enforcement is already live there; mt-track-s
  adds a second, auth-layer line of defence. This spec adds no enforcement at either layer.
- Shared resolvers in `require-tenant-admin.ts`: `resolveScopedTenant(req)` → `{scope:'all'}` for an exafy-admin,
  `{scope:'tenant', tenantId}` (from `req.targetTenantId`) otherwise — for list/queue reads; `resolveSingleTenant(req)`
  → `req.targetTenantId`, or `req.params.tenantId || req.identity.tenant_id` for an exafy-admin — for single-tenant
  config endpoints. Every new scoped moderation/signups/notifications/users/audit handler calls one of them only; the
  repositories (`admin-moderation-repository.ts`, `admin-tenants-repository.ts`, `community-marketplace-repository.ts`)
  take `tenantId: string | null` and add the predicate only when non-null. Guard test
  `test/mt-tenant-admin-scope-helper.test.ts` fails on a direct `identity.tenant_id` / `identity?.tenant_id` /
  `targetTenantId` read in the lane's listed files.
- Backfill: `admin-autopilot.ts` local → `resolveSingleTenant` (same result, regression-pinned);
  `admin-community-marketplace.ts` `/listings` → `resolveScopedTenant`, cross-tenant for an exafy-admin only with
  `MT_RESOLUTION_V2` on (flag off = today's own-tenant result); its writes → `resolveSingleTenant` (unchanged);
  `emitAdminActivity` (`:37-53`) takes `tenantId` as a parameter instead of reading the dropped local at `:50`, each
  call site passing its resolved tenant (payload unchanged).
- Deactivate/archive handlers emit `tenant.deactivated` / `tenant.archived` via `emit()` (`:301`) parameterised with a
  `vtid` argument defaulting to `PROVISION_VTID` (`:193`); the lifecycle handlers pass `LIFECYCLE_VTID` (this lane's
  VTID), the existing three callers stay on `VTID-05150`. Payload `{ tenant_id, slug, changed }`.
- `/admin/init-events`: NOT a gateway route and NOT touched by this lane — guarded in vitana-v1 at its existing path
  (lane `tenant-admin-pages`); `e2e/fixtures/routes.ts` already lists it as admin-only and is unchanged.
- Extend `GET /admin/tenants/:id/readiness` (via `gatherReadiness`) with first-admin-invitation delivery + lifecycle.
- exafy-admin routes over the lifecycle RPCs; the deactivated-tenant posture (member → default, exafy-admin read ok).
- Dark behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`.

## command-hub-tenant-module
NEW `tenant-admin.js` (`kind:"module"`) + `tenant-admin.css`; registered in `modules.json` (before `app.js`) and
`index.html`; exposes `window.TenantAdmin.render()`. `app.js` gains ONLY one render-switch case line. Lists tenants
(GET `/admin/tenants`), shows readiness + lifecycle, triggers deactivate/archive and first-admin invite re-delivery.
exafy-admin only + server-gated — the named dark-by-default exception.

## tenant-admin-pages (vitana-v1)
`InvitationAccept.tsx` at `/admin/invitations/accept/:token` mounted OUTSIDE the admin guard; it POSTs the token to the
EXISTING `POST /api/v1/admin/invitations/accept/:token` (VTID-05044) and surfaces that route's outcomes — 403
`EMAIL_UNVERIFIED`/`EMAIL_MISMATCH`, 409 `INVITATION_ROLES_INVALID`/`ALREADY_USED`, 410 `EXPIRED`, and the granted roles
on success — in i18n'd copy. The page enforces nothing itself (the route is authoritative) and shows only the roles the
route reports granted. Scoped tenant-admin pages (moderation, signups, notifications, users, audit) under
`src/pages/admin/tenant-admin/**` + `src/components/admin/tenant-admin/**`, consuming scoped reads via
`src/lib/tenant-admin-api.ts` (wrappers over `adminFetch`). A new App.tsx route also needs its `screens.json`/
`exclusions.json` row, `SCREEN_INVENTORY.md` entry, and `apps/mobile/parity/ledger.json` row. Spotlight tokens only,
logical start/end, skeletons; i18n DE-first du-form; RTL logical properties. No What's New entry (admin-only).
**`/admin/init-events`:** mount `InitEvents.tsx` in `App.tsx` under the admin `RouteGuard` (same guard the other
`/admin/*` pages use) at its existing path — guard, never remove — so it is no longer ungoverned. The gateway fixture
entry (`e2e/fixtures/routes.ts:193`) already matches and is not edited.

## Rules every successor follows
1. **Migrations:** apply strictly in `MIGRATION-QUEUE.md` order, one `RUN-MIGRATION.yml` dispatch per file, by Claude
   only, with read-only pre/post checks. New migrations take the next version in the lane's range and are added to the
   queue in the same PR. C3 `20261101070160` belongs to mt-community-isolation — never create it here; our files sort
   around it. A PR adding a not-yet-live table adds it to `scripts/ci/migration-drift-baseline.json`, removed after
   apply.
2. **Dark by default:** every merged code change is off unless enabled (`MT_RESOLUTION_V2`,
   `tenant_settings.feature_flags.mt.*`). The ONE named exception: the exafy-admin-only, server-gated Command Hub
   tenant module.
3. **VTID-05147 AC-5 still holds:** no later migration grants members writes on `user_tenants`/role tables or
   redefines `set_role_preference` without the membership check; the existing accept route (VTID-05044) already grants
   only allowlisted roles, and this spec adds no second grant path.
4. **Production is read-only** for every session and every test (CLAUDE.md 31/31b, 48). The executor never writes to
   Supabase or AWS (collaboration §7a); a DB change is a migration file applied later by Claude. Creating or
   deactivating a real tenant is an owner-approved step after Gate 2.
5. **Command Hub CSP:** external JS only, no inline script/style, every node via `textContent`, fetches through
   `buildContextHeaders()`; one app.js case line only.
6. Test/service accounts never visible to members (rules 43-45); i18n DE-first du-form; RTL via logical properties;
   Spotlight design contract; WCAG 2.2 AA. Required suites per touched slice: `npm run test:support` (42c),
   `npm run test:operator` (42e). Maxina golden suite must stay unchanged.
