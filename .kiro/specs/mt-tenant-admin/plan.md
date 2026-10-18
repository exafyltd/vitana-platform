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
   mints a first-admin `tenant_invitations` row and the provision response returns
   `accept_path:/admin/invitations/accept/<token>` (`admin-tenants.ts:371`). That path is ALREADY served by
   `services/gateway/src/routes/tenant-admin/invitations.ts` `acceptRouter`
   (`acceptRouter.post('/accept/:token', requireAuth, …)`, `:186`), mounted at `/api/v1/admin/invitations`
   (`index.ts:1429`), built under **VTID-05044**. It already enforces email-match (403 `EMAIL_MISMATCH`), role-allowlist
   re-check (409 `INVITATION_ROLES_INVALID`), expiry (410 `EXPIRED`) and atomic claim-before-grant (409 `ALREADY_USED`).
   What is MISSING is the **frontend accept page** — no page at `/admin/invitations/accept/:token` in `vitana-v1/src/pages`.
   So this spec owns only the accept-page UX consuming the existing endpoint; no new gateway accept route, no
   re-implemented enforcement.
2. **Tenant-admin surfaces are not tenant-scoped and some leak cross-tenant** (plan §3 S-F). `requireTenantAdmin`
   exists (`services/gateway/src/middleware/require-tenant-admin.ts`), attaches the resolved
   `req.targetTenantId` (`:159`, from `req.params.tenantId || req.identity.tenant_id` at `:102`) for a non-exafy
   caller. **Critically, the exafy-admin branch returns at `:96` (`if (req.identity.exafy_admin) { next(); return; }`)
   BEFORE `:159`, so `req.targetTenantId` is NEVER set for an exafy-admin.** The `admin-autopilot.ts` pattern
   `getTenantId(req) = (req as any).targetTenantId || req.identity?.tenant_id` (`admin-autopilot.ts:23-24`) therefore
   falls back to the exafy-admin's OWN `tenant_id` — i.e. applying that pattern to a scoped read silently scopes an
   exafy-admin to their own tenant instead of all tenants. There is **no exported `getTenantId(req)` helper** — only
   that per-file local in `admin-autopilot.ts:23` plus locals in `admin-marketplace.ts:31`/
   `admin-community-marketplace.ts:30` reading `req.identity.tenant_id`. The moderation / signups / notifications /
   users / audit admin reads do not all pin the caller's tenant, and today several are exafy-admin-only
   (`admin-signups.ts:32,62,113,… requireExafyAdmin`; `admin-moderation.ts:25,51` inline `verifyExafyAdmin`), so the
   fix must both scope the tenant-admin view AND preserve the exafy-admin cross-tenant view with an explicit
   `req.identity.exafy_admin` branch — the `targetTenantId || tenant_id` fallback alone regresses it.
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
   (pattern: `loops-catalog.js`, `modules.json:6`). There is no tenant-provisioning module yet.
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
  (`routes/tenant-admin/invitations.ts`, VTID-05044) — this lane does NOT create or edit it. **Auth-guard decision
  (conservative, no security widening): the lane ADDS new tenant-scoped endpoints guarded by `requireTenantAdmin`
  alongside the existing exafy-admin-only ones; it does NOT replace `requireExafyAdmin`/inline `verifyExafyAdmin` on
  the current endpoints.** This avoids widening exafy-admin-only data (e.g. `admin-signups.ts`' cross-tenant funnel
  counts/emails) to tenant-admins by default. Any route where the owner wants the SAME endpoint to serve both roles
  (replacing the guard with `requireTenantAdmin`) is a deliberate widening listed under `## Owner decisions` and held
  for owner approval before implementation. Each new scoped read derives the tenant from `req.targetTenantId` for a
  tenant-admin, **and MUST branch on `req.identity.exafy_admin` to omit the tenant filter** (because the middleware
  leaves `req.targetTenantId` unset for an exafy-admin, `require-tenant-admin.ts:96`) so the exafy-admin cross-tenant
  view is preserved, never silently scoped by a bare `targetTenantId || tenant_id` fallback. The lane also extends
  readiness (invitation-delivery + lifecycle), wires the deactivate/archive RPCs behind exafy-admin routes, defines the
  deactivated-tenant gateway API posture (O2). (The `/admin/init-events` guard is NOT here — it is a frontend route,
  owned by tenant-admin-pages.)
- **command-hub-tenant-module** (gateway frontend, seat jtadic): a NEW `tenant-admin.js` `kind:"module"` + CSS,
  registered in `modules.json` and `index.html`, exposing `window.TenantAdmin.render()`; app.js gets only the
  one render-switch case line (no large app.js edits). Lists tenants, shows readiness/lifecycle, triggers
  deactivate/archive and first-admin invitation delivery. **CI ownership guard (REQUIRED, same PR): the Command Hub
  directory is CI-protected — `scripts/ci/command-hub-ownership-guard.js:15` `PROTECTED_PATH =
  'services/gateway/src/frontend/command-hub/'` and `:1051` `ALLOWED_VTID_PATTERN` allowlist; the guard tests the
  branch name / PR title against it (`:1115`) and `process.exit(1)`s a PR touching the directory without an
  allowlisted marker.** This lane therefore ALSO edits `scripts/ci/command-hub-ownership-guard.js` to append its
  allocated VTID to `ALLOWED_VTID_PATTERN` (the one-line pattern update every prior Command Hub VTID made, e.g.
  VTID-05084). Until PLAN-SPAR allocates the VTID (`xxxxx`), this is a named TODO in the lane with the exact line to
  update, and the edit ships in the SAME PR as the module files. Because this is the only file outside the Command Hub
  directory the lane touches, the guard script is added to the lane's `paths`.
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
- Vitest/Jest (gateway): each new scoped read returns only the caller's tenant (b_admin sees 0 T_A rows) AND an
  exafy-admin still sees cross-tenant rows (the `req.identity.exafy_admin` branch, F2); readiness shape; deactivated-
  tenant posture (member → default, exafy-admin read ok); route-inventory green with the updated `/admin/init-events`
  fixture. Accept route NOT re-tested (VTID-05044 owns it).
- pgTAP: P2/P3 moderation + moderator tenant-scope (moderator of T_B sees 0 T_A reports);
  `deactivate_tenant`/`archive_tenant` idempotent; deactivated member resolves to default, never locked out; rollback
  restores.
- Vitest (vitana-v1): accept page renders outside the admin guard, surfaces email-mismatch/409/410; scoped pages
  render; no write on render; i18n keys resolve.
- Contract: scoped reads over route × role × tenant (no `CANARY_A` in a b_admin body).
- Required: `npm run test:support` (42c), `npm run test:operator` (42e). Maxina golden unchanged (no role-routing
  change).

## Staging verification
Read-only (rule 48), against `preview-aws-gateway.vitanaland.com` / `preview-aws.vitanaland.com`. Staging specs sign
in, navigate and read; a network guard aborts every non-GET except sign-in. Accept-page and scoped-admin staging specs
assert the panel/pages render for the right role and 403 for the wrong one; no write ever runs. `staging-tests.json`
per lane lists the Vitest + Playwright specs.

## Rollout
Dark by default: `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*` gate the scoped reads, the accept flow and
deactivate/archive. **Named exafy-only exception:** the Command Hub tenant module is exafy-admin-only + server-gated
(same shape as provisioning-ui). DB migrations applied by Claude via RUN-MIGRATION after merge, owner-approved; the
auth-hook (D14) is untouched. Creating/deactivating a real tenant is owner-approved after Gate 2.

## Risks
- Scoping an admin read could silently break an exafy-admin "all tenants" view: the middleware returns at
  `require-tenant-admin.ts:96` before setting `targetTenantId`, so a bare `targetTenantId || identity.tenant_id`
  fallback scopes an exafy-admin to their own tenant. Mitigation: every scoped read has an explicit
  `req.identity.exafy_admin` branch that omits the tenant filter; a Vitest asserts an exafy-admin still sees
  cross-tenant rows and a tenant-admin sees only their own.
- Command Hub CI ownership guard blocks the module PR if its VTID is not in `ALLOWED_VTID_PATTERN`
  (`command-hub-ownership-guard.js:1051`). Mitigation: the lane edits the guard in the same PR (above) and the guard
  file is in the lane's `paths`.
- Deactivate resolution must never lock a member out → the switch RPC falls back to the default tenant; pgTAP pins it.
- Moderator tenant-scope migration ordering vs mt-community-isolation C3 → fixed order with C3 reserved at `070160`.
- Command Hub app.js coupling → one render-switch case line only; module owns its own render tree (CSP: no inline JS).

## Out of scope
Provisioning core (DONE B/C); the gateway accept route (VTID-05044 — accept-page UX only, no route code); the S-G
auth-layer enforcement (mt-track-s, second line of defence — this spec adds no enforcement at either layer); C3
(mt-community-isolation); the auth hook (D14, WS1); native app (WS9); tenant-owner analytics (WS8); packs (WS5);
custom domains.

## Depends on
- DONE: VTID-05147 (S-M), VTID-05149 (A), VTID-05150 (B: `provision_tenant`, admin-tenants API, `tenant_invitations`),
  VTID-05151 (C: registry, `useTenant`); VTID-05044 (accept route — consumed, not rebuilt).
- Specs: mt-community-isolation (C3 `070160` reserved); mt-track-s (S-G auth-layer enforcement, a second line of
  defence — referenced, not duplicated); mt-m3 (O2 offboarding runbook).
- Lane order: the two DB lanes → tenant-admin-api → tenant-admin-pages + command-hub-tenant-module.

## Owner decisions
- D1 two scopes, D6 shared content + `{{brand}}`, D13 no synthetic tenant in production, D14 auth hook owner-applied —
  all DECIDED, applied as-is. Cross-spec rulings C3/O2/O4 applied (see handoff log).
- No new owner decision proposed; the deactivate/archive member-resolution default (fall back to default tenant) is
  the conservative reading of O2 and §4 "unresolved → reject, never oldest-tenant" (a deactivated-but-member tenant
  resolves to the member's default, not a reject).
- **Auth-guard widening (held for approval if chosen).** By default the lane adds NEW `requireTenantAdmin` endpoints
  beside the existing exafy-admin-only `admin-signups.ts`/`admin-moderation.ts` reads (no widening). Replacing those
  guards with `requireTenantAdmin` on the SAME endpoints — which would give tenant-admins access to data currently
  exafy-admin-only (signup funnel counts/emails) — is a deliberate security widening and is NOT done without explicit
  owner approval. Default: no widening.
<!-- plan:end -->

## Open questions for sparring
- O2 posture detail: should a deactivated tenant's gateway reads return 410/`TENANT_DEACTIVATED` or silently resolve
  the member to their default tenant? Proposed: member sessions resolve to default (no lockout); exafy-admin reads of
  the deactivated tenant still work for archival. Cross-spec with mt-m3 (offboarding runbook).
