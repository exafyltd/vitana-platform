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
   (`index.ts:1433`; `:1429` is the moderation mount), built under **VTID-05044**. It already enforces email-match (403 `EMAIL_MISMATCH`), role-allowlist
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
   `req.identity.exafy_admin` branch — the `targetTenantId || tenant_id` fallback alone regresses it. Two existing
   `requireTenantAdmin` files already carry the two divergent locals: `admin-autopilot.ts:23-24`
   (`targetTenantId || identity.tenant_id`, single-tenant config endpoints `/settings`, `/bindings` — `:37,65,112`)
   and `admin-community-marketplace.ts:26,30-31` (`router.use(requireTenantAdmin)`, `identity.tenant_id` only, used by
   the `/listings` queue read `:61` whose repository pins `.eq('tenant_id', f.tenantId)` —
   `community-marketplace-repository.ts:329-339`). For an exafy-admin the listings queue is silently own-tenant.
3. **`/admin/init-events` is an ungoverned FRONTEND surface.** The route is a vitana-v1 React page
   (`vitana-v1/src/pages/admin/InitEvents.tsx`, a static dev helper that shows a SQL script and `window.open`s the
   Supabase dashboard — it calls no gateway endpoint; not currently mounted in `App.tsx`). It appears in the gateway
   e2e route fixture `e2e/fixtures/routes.ts` under `ADMIN_ROUTES` (`:148`, the `/admin/init-events` entry at
   `:193`), which only the admin-role smoke specs visit (`admin: [...COMMUNITY_BASE_ROUTES, ...ADMIN_ROUTES]`, `:391`).
   **Decision: the page is GUARDED at its existing path, never removed** — vitana-v1's `App.tsx` mounts it under the
   admin `RouteGuard` at `/admin/init-events`. The fixture entry is then already correct (an admin-only route in the
   admin-only list), so **`e2e/fixtures/routes.ts` is NOT edited** and there is no cross-repo two-lane split to order.
   **No gateway `admin-init-events.ts` route exists or is created.**
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
  for owner approval before implementation.
  **One shared tenant resolver (REQUIRED, R1-F2):** the lane exports two helpers from
  `services/gateway/src/middleware/require-tenant-admin.ts` (beside `requireTenantAdmin`, so the gate and the reader
  of its result live in one file): `resolveScopedTenant(req)` → `{ scope: 'all' }` when `req.identity.exafy_admin`,
  else `{ scope: 'tenant', tenantId: req.targetTenantId }` (throws if a non-exafy caller reached it without
  `targetTenantId`), for LIST/queue reads; and `resolveSingleTenant(req)` → `req.targetTenantId`, or for an exafy-admin
  `req.params.tenantId || req.identity.tenant_id`, for single-tenant config endpoints where "all tenants" has no
  meaning. Every new scoped handler calls one of them and nothing else; repositories take `tenantId: string | null`
  and add the `tenant_id` predicate only when non-null. A Jest guard test
  (`services/gateway/test/mt-tenant-admin-scope-helper.test.ts`) reads an explicit list of the files this lane owns
  (the new scoped handlers + the two backfilled files below) and fails if any reads `identity.tenant_id`,
  `identity?.tenant_id` or `targetTenantId` directly instead of the helpers.
  **Backfill of the two existing divergent files (R1-F4):** `admin-autopilot.ts` drops its local `getTenantId`
  (`:23-24`) for `resolveSingleTenant` — identical result for both roles today (single-tenant settings/bindings,
  `repo.fetchSettingsFull(supabase, tenantId)` needs one tenant), so no behaviour change, pinned by a Jest regression.
  `admin-community-marketplace.ts` drops its local (`:30-31`) for `resolveScopedTenant` on the `/listings` queue read
  (`:61`): with `MT_RESOLUTION_V2` on, an exafy-admin sees the cross-tenant queue (repository `.eq` skipped for
  `null`); with the flag off (default) it keeps today's own-tenant result. Every other handler in the file (the
  writes `:88,147,225,268,314,351` and the `/reports` `:290` / `/categories` `:341` reads) keeps today's resolution
  via `resolveSingleTenant` (router mounted at `/api/v1/admin/community-marketplace`, `index.ts:1266`, no
  `:tenantId` param, so identical result). The file's OASIS helper `emitAdminActivity` (`:37-53`, 12 call sites) also
  read the dropped local for its payload (`:50`, `tenant_id: getTenantId(req)`): it gains an explicit
  `tenantId: string | null` parameter and every call site passes the value that handler already resolved
  (`resolveSingleTenant(req)` — for these routes, which carry no `:tenantId` param, that is `identity.tenant_id`
  for both roles, so the event payload is byte-identical to today; no guard-test exception is needed). Jest
  regressions: exafy-admin sees T_A + T_B listings (flag on), own tenant only (flag off), tenant-admin sees only its
  own either way; an `emitAdminActivity` payload still carries the caller's `tenant_id`.
  **OASIS events (REQUIRED, R1-F1/R2-F1):** the deactivate/archive handlers emit `tenant.deactivated` /
  `tenant.archived` with THIS spec's VTID, never the provisioning one. The existing `emit()` in `admin-tenants.ts`
  (`:301`) hardcodes `vtid: PROVISION_VTID` (`:193`, `'VTID-05150'`), so the lane parameterises it —
  `emit(type, message, actorId, payload, vtid = PROVISION_VTID)`, union widened by the two types — leaving the three
  existing callers (`:353`, `:455`, `:520`) unchanged, and adds `const LIFECYCLE_VTID = 'VTID-xxxxx'` (the
  tenant-admin-api lane's allocated VTID; a named TODO until PLAN-SPAR writes it) that both lifecycle handlers pass.
  Payload `{ tenant_id, slug, changed }` with `changed=false` for an idempotent re-call. Jest per handler asserts the
  event type AND `vtid === LIFECYCLE_VTID` (≠ `PROVISION_VTID`), and that `tenant.provisioned` still carries
  `VTID-05150`. The lane also extends readiness
  (invitation-delivery + lifecycle), wires the deactivate/archive RPCs behind exafy-admin routes, defines the
  deactivated-tenant gateway API posture (O2). (`/admin/init-events` is NOT here — it is a frontend route guarded in
  tenant-admin-pages at its existing path; `e2e/fixtures/routes.ts` is not edited, see Problem 3.)
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
  **governs the `/admin/init-events` frontend route** — mounts `InitEvents.tsx` in `App.tsx` under the admin
  `RouteGuard` at its existing path `/admin/init-events` (guard, not remove). The gateway fixture entry
  (`e2e/fixtures/routes.ts:193`, `ADMIN_ROUTES`) already lists it as admin-only and is NOT edited, so the change lands
  in one repo, one PR.

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
- Jest (gateway): each new scoped read returns only the caller's tenant (b_admin sees 0 T_A rows) AND an
  exafy-admin still sees cross-tenant rows (via `resolveScopedTenant`); helper unit tests for both resolvers; the
  scope-helper guard test (no direct `identity.tenant_id`/`targetTenantId` reads in the listed files); backfill
  regressions for `admin-autopilot.ts` (unchanged result) and `admin-community-marketplace.ts` `/listings` (flag on:
  cross-tenant for exafy-admin; flag off: today's result); deactivate/archive emit `tenant.deactivated` /
  `tenant.archived`; readiness shape; deactivated-tenant posture (member → default, exafy-admin read ok). Accept
  route NOT re-tested (VTID-05044 owns it). `e2e/fixtures/routes.ts` unchanged.
- pgTAP: P2/P3 moderation + moderator tenant-scope (moderator of T_B sees 0 T_A reports);
  `deactivate_tenant`/`archive_tenant` idempotent; deactivated member resolves to default, never locked out; rollback
  restores.
- Vitest (vitana-v1): accept page renders outside the admin guard, surfaces email-mismatch/409/410; scoped pages
  render; `/admin/init-events` is reachable only through the admin `RouteGuard`; no write on render; i18n keys
  resolve.
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
  fallback scopes an exafy-admin to their own tenant. Mitigation: one exported resolver pair
  (`resolveScopedTenant` / `resolveSingleTenant`) is the only way the lane's handlers read the tenant, enforced by a
  Jest guard test; Jest asserts an exafy-admin still sees cross-tenant rows and a tenant-admin sees only their own.
- Backfilling `admin-community-marketplace.ts` `/listings` changes the exafy-admin queue from own-tenant to
  cross-tenant. Mitigation: only behind `MT_RESOLUTION_V2` (dark default = today's result); writes unchanged;
  `admin-autopilot.ts` backfill is result-identical.
- Command Hub CI ownership guard blocks the module PR if its VTID is not in `ALLOWED_VTID_PATTERN`
  (`command-hub-ownership-guard.js:1051`). Mitigation: the lane edits the guard in the same PR (above) and the guard
  file is in the lane's `paths`.
- Deactivate resolution must never lock a member out → the switch RPC falls back to the default tenant; pgTAP pins it.
- Lifecycle changes invisible to downstream consumers → deactivate/archive emit OASIS `tenant.deactivated` /
  `tenant.archived` like provisioning does (`admin-tenants.ts:353`); Jest pins each emit.
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
