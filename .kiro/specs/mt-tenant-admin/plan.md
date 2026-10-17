---
change_class: standard
---
# mt-tenant-admin — provisioning rest, scoped tenant-admin, invitation accept, deactivate/archive (WS4)

<!-- plan:begin -->
## Problem
Provisioning core is DONE (B VTID-05150, C VTID-05151): `provision_tenant()`, exafy-admin `POST/PATCH /admin/tenants`,
assets, readiness, public registry, DB-driven `useTenant`. WS4 rest is unbuilt. Verified today (vitana-platform-1,
read-only):
1. **The gateway accept route EXISTS and is hardened; only the frontend accept page is missing.** `provision_tenant()`
   mints a first-admin row in `tenant_invitations`
   (`supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:212-222`; table at
   `20260412000000_tenant_invitations.sql:9` with `token`, `roles[]`, `email`, `accepted_at`, `revoked_at`,
   `expires_at`). The provision response returns `accept_path:/admin/invitations/accept/<token>`
   (`services/gateway/src/routes/admin-tenants.ts:371`). That path is ALREADY served:
   `services/gateway/src/routes/tenant-admin/invitations.ts` exports `acceptRouter`
   (`acceptRouter.post('/accept/:token', requireAuth, …)`, `:186`), mounted at `/api/v1/admin/invitations`
   (`services/gateway/src/index.ts:501,1429`), built under **VTID-05044 (Track S / S4)**. It already enforces
   confirmed-email + email-match (403 `EMAIL_UNVERIFIED`/`EMAIL_MISMATCH`, `:208-233`), role allowlist re-check with
   super-admin-only refusal (409 `INVITATION_ROLES_INVALID`, `:237-268`), expiry (410 `EXPIRED`, `:200`), atomic
   claim-before-grant (409 `ALREADY_USED`, `:289-299`), and grants only the validated roles via
   `upsertUserPermittedRole` (`:312-319`). What is MISSING is the **frontend accept page** — grep of
   `vitana-v1/src/pages` finds only group/partner accept pages, no page at `/admin/invitations/accept/:token`. So this
   spec owns only the accept-page UX that consumes the existing endpoint; it introduces no new gateway accept route and
   re-implements no enforcement.
2. **Tenant-admin surfaces are not tenant-scoped and some leak cross-tenant** (plan §3 S-F). `requireTenantAdmin`
   exists (`services/gateway/src/middleware/require-tenant-admin.ts`), attaches the resolved
   `req.targetTenantId` (`:160`, from `req.params.tenantId || req.identity.tenant_id` at `:102`) and bypasses tenant
   checks for exafy-admin (Step 2, `:97-99`); it is used by `admin-autopilot.ts` (`:4-6`). There is **no exported
   `getTenantId(req)` helper** — only per-file locals (`admin-marketplace.ts:31`, `admin-community-marketplace.ts:30`)
   reading `req.identity.tenant_id`. The moderation / signups / notifications / users / audit admin reads do not all
   pin the caller's tenant from `requireTenantAdmin`.
3. **`/admin/init-events` is an ungoverned FRONTEND surface.** The route is a vitana-v1 React page
   (`vitana-v1/src/pages/admin/InitEvents.tsx`, a static dev helper that shows a SQL script and `window.open`s the
   Supabase dashboard — it calls no gateway endpoint; not currently mounted in `App.tsx`). It appears in the gateway
   route-inventory fixture `e2e/fixtures/routes.ts` under `ADMIN_ROUTES` (the `/admin/init-events` entry). The guard
   belongs in vitana-v1's `App.tsx` (admin `RouteGuard`) or the page is removed; the fixture entry is updated so the
   route-inventory test stays green. **No gateway `admin-init-events.ts` route exists or is created.**
4. **No deactivate/archive.** `tenants` has `is_active`/`is_platform`/`is_default` (read at
   `admin-tenants.ts:253`, which already excludes `is_active === false` and `is_platform === true` from the
   switch-target set), but there is no RPC to deactivate/archive a tenant, no resolution rule for a deactivated
   tenant's members, and no defined gateway API posture for a deactivated tenant (cross-spec O2 — this spec owns it
   end to end).
5. **No Command Hub tenant module.** The Command Hub loads JS via `modules.json` + `index.html` script tags; a new
   screen is a `kind:"module"` file exposing `window.X.render()` that `app.js` calls from its render switch
   (pattern: `loops-catalog.js`, `modules.json:7`). There is no tenant-provisioning module yet.
6. **Readiness is minimal.** `GET /admin/tenants/:id/readiness` (`admin-tenants.ts:536`) reports a fixed set; WS4 needs
   first-admin-invitation delivery state and lifecycle (active/deactivated) surfaced.

## Fix (per lane)
- **tenant-admin-moderation-db** (DB, seat hotmail): migrations P2 (`070100`), P3 (`070150`), moderator-tenant-scope
  (`070600`) adding the moderation RPCs/triggers and the moderator tenant-scope predicate (O4 — this spec + this lane
  own moderation; no `moderation-tenant-db` lane). Reserve C3 at `070160` (mt-community-isolation) — our files sort
  around it. Each migration: rollback file, read-only pre/post checks, MIGRATION-QUEUE row.
- **tenant-lifecycle-db** (DB, seat hotmail): `deactivate_tenant(slug)` / `archive_tenant(slug)` RPCs + the closing
  switch RPC change so a deactivated tenant's members resolve to the default tenant (never a hard lockout), expand/
  contract, rollback, pre/post checks (O2). Migrations `070300`/`070350`.
- **tenant-admin-api** (gateway, seat jtadic): the accept route already exists and is hardened
  (`routes/tenant-admin/invitations.ts`, VTID-05044) — this lane does NOT create or edit it. It tenant-scopes every
  moderation/signups/notifications/users/audit admin read by the tenant resolved from `requireTenantAdmin`
  (`req.targetTenantId`, caller's own = `req.identity.tenant_id`), keeping the exafy-admin bypass the middleware already
  provides; extends readiness (invitation-delivery + lifecycle), wires the deactivate/archive RPCs behind exafy-admin
  routes, defines the deactivated-tenant gateway API posture (O2). (The `/admin/init-events` guard is NOT here — it is a
  frontend route, owned by tenant-admin-pages.)
- **command-hub-tenant-module** (gateway frontend, seat jtadic): a NEW `tenant-admin.js` `kind:"module"` + CSS,
  registered in `modules.json` and `index.html`, exposing `window.TenantAdmin.render()`; app.js gets only the
  one render-switch case line (no large app.js edits). Lists tenants, shows readiness/lifecycle, triggers
  deactivate/archive and first-admin invitation delivery.
- **tenant-admin-pages** (vitana-v1, seat exafyltd): the invitation **accept page outside the admin guard** that
  consumes the existing `POST /api/v1/admin/invitations/accept/:token` (surfacing its 403 `EMAIL_MISMATCH`/
  `EMAIL_UNVERIFIED`, 409, 410 as user-readable states; the page adds no enforcement of its own) and the scoped
  tenant-admin pages (moderation, signups, notifications, users, audit) consuming the scoped gateway reads; Spotlight
  tokens, i18n DE-first du-form, RTL logical properties. Also
  **governs the `/admin/init-events` frontend route** — wrap it in the admin `RouteGuard` in `App.tsx` (or remove the
  page). The matching gateway fixture entry (`e2e/fixtures/routes.ts`, `ADMIN_ROUTES`) is updated in the
  tenant-admin-api lane so the route-inventory test stays green.

## Migrations
Range `20261101070000`–`20261101075959` (NN=07). Files, all with a paired rollback under the lane's
`docs/validation/<vtid>/` and read-only pre/post checks:
- `20261101070100_vtid_xxxxx_mt_tenant_admin_p2_moderation.sql` (+ rollback) — tenant-admin-moderation-db.
- `20261101070150_vtid_xxxxx_mt_tenant_admin_p3_moderation.sql` (+ rollback) — tenant-admin-moderation-db.
- **C3 `20261101070160` is RESERVED by mt-community-isolation** — not created here; our files sort around it.
- `20261101070300_vtid_xxxxx_mt_tenant_deactivate.sql` (+ rollback) — tenant-lifecycle-db.
- `20261101070350_vtid_xxxxx_mt_tenant_archive_switch.sql` (+ rollback) — tenant-lifecycle-db.
- `20261101070600_vtid_xxxxx_mt_moderator_tenant_scope.sql` (+ rollback) — tenant-admin-moderation-db.
MIGRATION-QUEUE position (CROSS-SPEC C3 ordering): P2 (`070100`) → P3 (`070150`) → **C3 (`070160`, mt-community-
isolation)** → deactivate (`070300`) → archive-switch (`070350`) → moderator-tenant-scope (`070600`). Each lane adds
its own queue rows in the same PR that adds the files; a not-yet-live table is added to
`scripts/ci/migration-drift-baseline.json` and removed after apply. Apply is Claude via RUN-MIGRATION after merge,
owner-approved, off-peak; expand/contract only, `lock_timeout` + retries, snapshot before any data move.

## Tests
- Vitest/Jest (gateway): every scoped admin read returns only the caller's tenant (b_admin sees 0 T_A rows);
  readiness shape (invitation-delivery + lifecycle); deactivated-tenant API posture (member → default, exafy-admin read
  ok per O2 design); the route-inventory test stays green with the updated `/admin/init-events` fixture entry. The
  accept route is NOT re-tested here — it is owned and regression-covered by VTID-05044
  (`routes/tenant-admin/invitations.ts`); the accept behaviour this spec cares about is proven at the frontend-page
  level below.
- pgTAP: P2/P3 moderation RPCs + moderator tenant-scope predicate (a moderator of T_B sees 0 T_A reports);
  `deactivate_tenant`/`archive_tenant` idempotent; a deactivated tenant's member resolves to the default tenant, never
  locked out; rollback restores prior state.
- Vitest (vitana-v1): accept page renders outside the admin guard, blocks on email mismatch, lists only allowlisted
  roles; scoped admin pages render; no write on render; i18n keys resolve.
- Contract: scoped reads over route × role × tenant (no `CANARY_A` in a b_admin body).
- Required suites per touched slice: `npm run test:support` (42c), `npm run test:operator` (42e); role-separation
  (42h) if an ORB/role surface is touched (not expected here).
- **Maxina golden suite unchanged**: no Maxina/role-routing/greeting output changes in scope.

## Staging verification
Read-only (rule 48), against `preview-aws-gateway.vitanaland.com` / `preview-aws.vitanaland.com`. Staging specs sign
in, navigate and read; a network guard aborts every non-GET except sign-in. Accept-page and scoped-admin staging specs
assert the panel/pages render for the right role and 403 for the wrong one; no write ever runs. `staging-tests.json`
per lane lists the Vitest + Playwright specs.

## Rollout
Dark by default: `MT_RESOLUTION_V2` env master + `tenant_settings.feature_flags.mt.*` gate the scoped-read behaviour,
the accept flow and deactivate/archive. **Exception (named, exafy-only):** the Command Hub tenant module is exafy-admin
only and server-gated — no member can see it (same shape as the provisioning-ui exception). DB migrations are applied
by Claude via RUN-MIGRATION after merge with owner approval; the auth-hook (D14) is not touched here. Creating or
deactivating a real tenant is an owner-approved step after Gate 2.

## Risks
- Scoping an existing admin read could break an exafy-admin "all tenants" view → every scoped route keeps the
  exafy-admin super-admin branch (`requireTenantAdmin` already supports both, `admin-autopilot.ts:4-6`).
- Deactivate resolution must never lock a member out → the switch RPC falls back to the default tenant; pgTAP pins it.
- Moderator tenant-scope migration ordering vs mt-community-isolation C3 → fixed order with C3 reserved at `070160`.
- Command Hub app.js coupling → one render-switch case line only; module owns its own render tree (CSP: no inline JS).

## Out of scope
Provisioning core (DONE: B/C); the gateway accept route itself (ALREADY built and hardened, VTID-05044,
`routes/tenant-admin/invitations.ts` — this spec owns only the accept-page UX, not any accept-route code); the S-G
auth-layer enforcement (mt-track-s adds a second, auth-layer line of defence; the application-layer email-match +
role-allowlist already live in the accept route, so this spec introduces NO enforcement at either layer); community
isolation C3 (mt-community-isolation); the access-token auth hook (D14, WS1); native app (WS9); tenant-owner analytics
(WS8); content/assistant packs (WS5); custom domains.

## Depends on
- DONE: VTID-05147 (S-M), VTID-05149 (A: `tenants.is_default`/`is_platform`, `TenantContext`,
  `ci_tenant_isolation_health()`), VTID-05150 (B: `provision_tenant`, admin-tenants API, `tenant_invitations`
  first-admin row), VTID-05151 (C: public registry, `useTenant`).
- DONE accept route: VTID-05044 (`routes/tenant-admin/invitations.ts` `acceptRouter`, email-match + role-allowlist +
  expiry + atomic claim; mounted `index.ts:1429`) — this spec's accept page consumes it, does not re-build it.
- Specs: mt-community-isolation (C3 migration `070160` reserved; moderator-tenant-scope sorts after it);
  mt-track-s (adds the S-G enforcement at the auth layer as a second line of defence — referenced, not duplicated;
  the application-layer check already exists in the accept route); mt-m3 (references O2, owns the offboarding runbook).
- Lane order within this spec: tenant-admin-moderation-db and tenant-lifecycle-db (DB) before the gateway lane that
  wires their RPCs; tenant-admin-api before tenant-admin-pages and command-hub-tenant-module (they consume its routes).

## Owner decisions
- D1 two scopes, D6 shared content + `{{brand}}`, D13 no synthetic tenant in production, D14 auth hook owner-applied —
  all DECIDED, applied as-is. Cross-spec rulings C3/O2/O4 applied (see handoff log).
- No new owner decision proposed; the deactivate/archive member-resolution default (fall back to default tenant) is
  the conservative reading of O2 and §4 "unresolved → reject, never oldest-tenant" (a deactivated-but-member tenant
  resolves to the member's default, not a reject).
<!-- plan:end -->

## Open questions for sparring
- O2 posture detail: should a deactivated tenant's gateway reads return 410/`TENANT_DEACTIVATED` or silently resolve
  the member to their default tenant? Proposed: member sessions resolve to default (no lockout); exafy-admin reads of
  the deactivated tenant still work for archival. Cross-spec with mt-m3 (offboarding runbook).
