# Tasks — mt-tenant-admin-r2 (spec 07, WS4 rest; re-plan of mt-tenant-admin)

Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`. VTIDs: allocated by CI PLAN-SPAR after policy approval.
Every lane: `executor: kiro`, reviewed by `agent:vitana-lane-reviewer`; migrations applied by Kiro only on the owner's
approval of the files and the target database (`collaboration.md` §7d).

<!-- lane: tenant-admin-moderation-db -->
## tenant-admin-moderation-db — P2/P3 + moderator tenant-scope (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102070100_vtid_*_mt_tenant_admin_p2_moderation.sql`,
`supabase/migrations/20261102070150_vtid_*_mt_tenant_admin_p3_moderation.sql`,
`supabase/migrations/20261102070600_vtid_*_mt_moderator_tenant_scope.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`,
`scripts/ci/migration-drift-baseline.json`. The lane also creates `docs/validation/<vtid>/` (not listed here per
collaboration §2). mt-community-isolation-r2 C3 `20261102070160` is NOT created here.

- [ ] M1 P2 migration (`070100`): moderation RPCs/triggers (O4), rollback in `docs/validation/<vtid>/`, read-only
      pre/post checks, MIGRATION-QUEUE row. Expand/contract, `lock_timeout` + retries.
- [ ] M2 P3 migration (`070150`): moderation follow-up RPCs/triggers; same rollback/checks/queue discipline.
- [ ] M3 Moderator tenant-scope migration (`070600`): predicate restricting a moderator to their own tenant's reports;
      sorts after C3 (`070160`); rollback/checks/queue row.
- [ ] M4 pgTAP: a moderator of T_B sees 0 T_A reports; RPCs idempotent; rollbacks restore prior state.
- [ ] M5 Add/remove not-yet-live tables in `scripts/ci/migration-drift-baseline.json` around apply.

Acceptance: migrations idempotent and expand/contract; rollbacks + pre/post checks present; MIGRATION-QUEUE rows at
P2 → P3 → … → moderator-tenant-scope with C3 reserved at `070160`; pgTAP green. No Supabase/AWS writes (applied later
by Kiro on the owner's approval of the files and the target database, §7d). PR title `VTID-xxxxx (mt-tenant-admin-r2/tenant-admin-moderation-db): …`; commits carry `Collab-Session` /
`Collab-Lane: mt-tenant-admin-r2/tenant-admin-moderation-db`.

<!-- lane: tenant-lifecycle-db -->
## tenant-lifecycle-db — deactivate/archive + closing switch RPC (repo vitana-platform)

Allowed paths: `supabase/migrations/20261102070300_vtid_*_mt_tenant_deactivate.sql`,
`supabase/migrations/20261102070350_vtid_*_mt_tenant_archive_switch.sql`, `docs/multitenancy/MIGRATION-QUEUE.md`,
`scripts/ci/migration-drift-baseline.json`. The lane also creates `docs/validation/<vtid>/`.

- [ ] L1 `deactivate_tenant(slug)` (`070300`): sets `tenants.is_active = false`, idempotent, rollback + pre/post
      checks + MIGRATION-QUEUE row.
- [ ] L2 `archive_tenant(slug)` + closing switch RPC change (`070350`): a member of a deactivated tenant resolves to
      the default tenant (`is_default`), never a lockout; rollback + checks + queue row.
- [ ] L3 pgTAP: idempotent RPCs; deactivated-tenant member resolves to default; exafy-admin can still read it;
      rollback restores prior state.
- [ ] L4 Maintain `migration-drift-baseline.json` around apply.

Acceptance: expand/contract; rollbacks + pre/post checks; MIGRATION-QUEUE rows after C3 (deactivate `070300` →
archive `070350`); pgTAP green. No Supabase/AWS writes. PR title `VTID-xxxxx (mt-tenant-admin-r2/tenant-lifecycle-db):
…`; commits carry `Collab-Session` / `Collab-Lane: mt-tenant-admin-r2/tenant-lifecycle-db`.

<!-- lane: tenant-admin-api -->
## tenant-admin-api — scoped reads + shared tenant resolver, readiness, lifecycle (repo vitana-platform)

Allowed paths: `services/gateway/src/routes/admin-tenants.ts`,
`services/gateway/src/routes/admin-tenants-repository.ts`, `services/gateway/src/routes/admin-signups.ts`,
`services/gateway/src/routes/admin-community-marketplace.ts`, `services/gateway/src/routes/admin-moderation.ts`,
`services/gateway/src/routes/admin-moderation-repository.ts`,
`services/gateway/src/index.ts`, `services/gateway/src/services/tenant-provisioning/**`,
`services/gateway/src/middleware/require-tenant-admin.ts`, `services/gateway/src/routes/admin-autopilot.ts`,
`services/gateway/src/services/community-marketplace/community-marketplace-repository.ts`,
`services/gateway/test/mt-tenant-admin-*.test.ts`. (`e2e/fixtures/routes.ts` is NOT edited.) The lane also creates
`docs/validation/<vtid>/`. Depends on `tenant-admin-moderation-db` + `tenant-lifecycle-db`. The invitation-accept route
is NOT in scope — it already exists and is hardened (`routes/tenant-admin/invitations.ts`, VTID-05044); this lane does
not create `admin-invitations.ts` and does not edit the existing route.

- [ ] A1 Auth-guard decision (no widening by default): ADD new `requireTenantAdmin`-guarded tenant-scoped endpoints
      ALONGSIDE the existing exafy-admin-only ones (`admin-signups.ts:34,64,115,… requireExafyAdmin`;
      `admin-moderation.ts:25,51` inline `verifyExafyAdmin`). Do NOT replace those guards (that would widen
      exafy-admin-only funnel/report data to tenant-admins) unless the owner approved the widening in the plan's
      `## Owner decisions`.
- [ ] A2 Export `resolveScopedTenant(req, env = process.env)` (`{scope:'all'}` for `req.identity.exafy_admin` only when
      `isMtResolutionV2Enabled(env)` — flag off → the exafy-admin's own `req.params.tenantId || req.identity.tenant_id`
      (R3-F1) — else
      `{scope:'tenant', tenantId: req.targetTenantId}`, throw if unset) and `resolveSingleTenant(req)`
      (`req.targetTenantId`, or `req.params.tenantId || req.identity.tenant_id` for an exafy-admin) from
      `services/gateway/src/middleware/require-tenant-admin.ts`. Needed because `:96` returns before `:160`, so
      `req.targetTenantId` is unset for an exafy-admin and a bare `targetTenantId || identity.tenant_id`
      (`admin-autopilot.ts:23-24`) silently scopes them to their own tenant. Every new scoped handler calls one of
      the two helpers only; repositories take `tenantId: string | null` and add the predicate only when non-null.
- [ ] A3 Backfill the two existing divergent files onto the helpers: `admin-autopilot.ts` local `getTenantId`
      (`:23-24`) → `resolveSingleTenant` (same result for both roles); `admin-community-marketplace.ts` local
      (`:30-31`) → `resolveScopedTenant` on `/listings` (`:61`; cross-tenant for an exafy-admin only with
      `MT_RESOLUTION_V2` on, `community-marketplace-repository.ts:339` `.eq` skipped for `null`) and
      `resolveSingleTenant` on its writes (unchanged); its `emitAdminActivity` (`:37-53`) gains a
      `tenantId: string | null` parameter replacing the `:50` `getTenantId(req)` read, every call site passing its
      resolved tenant (payload unchanged). (`/admin/init-events` is NOT in this lane and
      `e2e/fixtures/routes.ts` is not edited — the page is guarded at its existing path in `tenant-admin-pages`.)
- [ ] A4 Extend `GET /admin/tenants/:id/readiness` with first-admin-invitation delivery + lifecycle.
- [ ] A5 exafy-admin deactivate/archive routes over the lifecycle RPCs; deactivated-tenant posture (member → default,
      exafy-admin read ok). Each handler emits `tenant.deactivated` / `tenant.archived` via the `emit()` in
      `admin-tenants.ts:301`, parameterised with `vtid = PROVISION_VTID` (`:193`) and called with
      `LIFECYCLE_VTID = 'VTID-xxxxx'` (this lane's VTID, named TODO until allocated); existing callers unchanged;
      payload `{ tenant_id, slug, changed }`. Jest asserts `vtid === LIFECYCLE_VTID` per handler. Dark behind
      `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`.
- [ ] A6 Jest in `services/gateway/test/mt-tenant-admin-*.test.ts`: scoped reads (b_admin sees 0 T_A rows); **an
      exafy-admin still sees cross-tenant rows on the new scoped endpoints**; both resolvers unit-tested;
      `mt-tenant-admin-scope-helper.test.ts` guard (fails on a direct `identity.tenant_id` / `identity?.tenant_id` /
      `targetTenantId` read in ANY non-test `src/**/*.ts` importing `middleware/require-tenant-admin`,
      except a committed shrink-only `LEGACY_DIRECT_READ` baseline; fails also when a baseline file is clean but still
      listed — R3-F2); target tenant kept in a module-private `WeakMap<Request,string>` read only by the helpers (the
      `:160` `(req as any).targetTenantId` write kept one release for the baseline files); backfill regressions (`admin-autopilot.ts`
      unchanged result; `/listings` flag on = cross-tenant for exafy-admin, flag off = today's, tenant-admin own-only
      either way); each lifecycle handler emits its OASIS event; readiness shape; deactivated-tenant posture. (The
      accept route is covered by VTID-05044, not re-tested here.) Plus `npm run test:support` +
      `npm run test:operator` stay green.
- [ ] A7 `docs/validation/<vtid>/`: `scope.json`, `staging-tests.json` (read-only specs), plan-sparring copy.

Acceptance: full gateway test suite green; scoped reads prove tenant isolation via the shared resolvers; the
scope-helper guard test green; lifecycle OASIS events emitted; `e2e/fixtures/routes.ts` unchanged; dark by default. Never calls a write
endpoint against a live system. PR title `VTID-xxxxx
(mt-tenant-admin-r2/tenant-admin-api): …`; commits carry `Collab-Session` / `Collab-Lane: mt-tenant-admin-r2/
tenant-admin-api`.

<!-- lane: command-hub-tenant-module -->
## command-hub-tenant-module — NEW Command Hub module (repo vitana-platform)

Allowed paths: `services/gateway/src/frontend/command-hub/tenant-admin.js`,
`services/gateway/src/frontend/command-hub/tenant-admin.css`,
`services/gateway/src/frontend/command-hub/modules.json`, `services/gateway/src/frontend/command-hub/index.html`,
`services/gateway/src/frontend/command-hub/app.js`,
`services/gateway/test/mt-tenant-admin-command-hub-*.test.ts`, `scripts/ci/command-hub-ownership-guard.js`. The lane
also creates `docs/validation/<vtid>/`. Depends on `tenant-admin-api`.

- [ ] C1 `tenant-admin.js` (`kind:"module"`) exposing `window.TenantAdmin.render()` + `tenant-admin.css`; register in
      `modules.json` (before `app.js`) and `index.html`. CSP: external JS only, no inline script/style, nodes via
      `textContent`, fetches through `buildContextHeaders()`.
- [ ] C2 `app.js`: ONE render-switch case line calling `window.TenantAdmin.render()` — nothing else.
- [ ] C3 Module UI: list tenants, show readiness + lifecycle, trigger deactivate/archive and first-admin invite
      re-delivery. exafy-admin only + server-gated.
- [ ] C4 Test in `services/gateway/test/mt-tenant-admin-command-hub-*.test.ts`: module registered; render builds nodes
      via `textContent`; app.js diff is a single case.
- [ ] C5 CI ownership guard: append the allocated VTID to `ALLOWED_VTID_PATTERN` at
      `scripts/ci/command-hub-ownership-guard.js:1051` (one-line pattern add, same mechanism as prior Command Hub
      VTIDs), in THIS PR, so the guard (`:15` PROTECTED_PATH, `:1115` branch/PR-title test) does not block the module
      files.

Acceptance: new module loads without large app.js edits; CSP clean; exafy-admin-only; the command-hub ownership-guard
PR check passes (VTID appended to `ALLOWED_VTID_PATTERN`). PR title `VTID-xxxxx
(mt-tenant-admin-r2/command-hub-tenant-module): …`; commits carry `Collab-Session` / `Collab-Lane: mt-tenant-admin-r2/
command-hub-tenant-module`.

<!-- lane: tenant-admin-pages -->
## tenant-admin-pages — accept page + scoped tenant-admin pages (repo vitana-v1)

Allowed paths: `src/pages/admin/InvitationAccept.tsx`, `src/pages/admin/tenant-admin/**`,
`src/components/admin/tenant-admin/**`, `src/lib/tenant-admin-api.ts`, `src/lib/tenant-admin-api.test.ts`,
`src/App.tsx`, `src/i18n/de/tenantAdmin.json`, `src/i18n/en/tenantAdmin.json`,
`src/navigation/registry/screens.json`, `src/navigation/registry/exclusions.json`,
`apps/mobile/parity/ledger.json`, `tests/e2e/staging/mt-tenant-admin-*.staging.spec.ts`, `docs/SCREEN_INVENTORY.md`,
`i18n-source-stamps/**`. The lane also creates `docs/validation/<vtid>/`. Depends on `tenant-admin-api`.

- [ ] P1 `src/lib/tenant-admin-api.ts`: typed wrappers over `adminFetch` for the accept endpoint + scoped reads; error
      codes mapped to i18n keys (`FORBIDDEN`, email-mismatch, 410/409).
- [ ] P2 `InvitationAccept.tsx` at `/admin/invitations/accept/:token`, mounted in `App.tsx` OUTSIDE the admin guard;
      POSTs the token to the EXISTING `POST /api/v1/admin/invitations/accept/:token` (VTID-05044) and surfaces its
      outcomes in i18n'd copy — 403 `EMAIL_UNVERIFIED`/`EMAIL_MISMATCH`, 409 `INVITATION_ROLES_INVALID`/`ALREADY_USED`,
      410 `EXPIRED`, and the granted roles on success. The page enforces nothing itself and shows only the roles the
      route reports granted.
- [ ] P2b Govern `/admin/init-events` (`src/pages/admin/InitEvents.tsx`): it is ALREADY mounted unguarded at
      `App.tsx:2217` (lazy import `:433`) — WRAP that route in `<AuthGuard><ProtectedRoute requiredRole="admin">` (the
      pattern at `:2192`), no new mount; previously planned as: mount it in `App.tsx` under the admin
      `RouteGuard` at its existing path `/admin/init-events`, the same way the other `/admin/*` pages are (guard, never
      remove). The gateway fixture entry (`e2e/fixtures/routes.ts:193`, `ADMIN_ROUTES`) already lists it as admin-only
      and is NOT edited. Vitest: the route renders only through the admin guard.
- [ ] P3 Scoped tenant-admin pages (moderation, signups, notifications, users, audit) under
      `src/pages/admin/tenant-admin/**` + `src/components/admin/tenant-admin/**`, consuming the scoped reads; Spotlight
      tokens, logical start/end, skeletons.
- [ ] P4 i18n: `src/i18n/de/tenantAdmin.json` first (du-form), mirror to `en/`; `npm run i18n:inventory`
      (regenerates `docs/SCREEN_INVENTORY.md`, `i18n-source-stamps/**`).
- [ ] P5 New App.tsx route: add `screens.json`/`exclusions.json` row + `apps/mobile/parity/ledger.json` row
      (`node scripts/native/parity-ledger.mjs --sync`) so `npm test` passes.
- [ ] P6 Vitest `src/lib/tenant-admin-api.test.ts`: wrapper URLs/bodies/error mapping; accept page surfaces the
      route's 403 `EMAIL_MISMATCH` as the user-readable mismatch state (mocked response, no enforcement in the page);
      scoped pages render; no write on render.
- [ ] P7 Staging spec `tests/e2e/staging/mt-tenant-admin-*.staging.spec.ts` (read-only): accept route renders for the
      invited email; scoped pages visible to a tenant admin, 403/empty for the wrong tenant; non-GET network guard.
- [ ] P8 `docs/validation/<vtid>/`: plan-sparring copy, `scope.json`, `staging-tests.json`.

Acceptance: all Vitest + full `npx vitest run` green, ESLint (i18n + design) clean on new files, PR gate scope/
sparring green, no What's New entry (admin-only). Kiro never calls a write endpoint against any live system. PR title
`VTID-xxxxx (mt-tenant-admin-r2/tenant-admin-pages): …`; commits carry `Collab-Session` / `Collab-Lane: mt-tenant-admin-r2/
tenant-admin-pages`.

## Escalation carry-over (from `mt-tenant-admin`, session `03698d49`, round 3)
Each finding is answered in `plan.md` "Re-plan answers"; the tasks carry the acceptance.
- R3-F1 [major], verbatim: "The R1-F4 backfill changes admin-community-marketplace.ts /listings to use resolveScopedTenant,
  and the plan states 'with MT_RESOLUTION_V2 on, an exafy-admin sees the cross-tenant queue ... with the flag off
  (default) it keeps today's own-tenant result.' But the plan's specification of resolveScopedTenant is flag-agnostic:
  it returns `{ scope: 'all' }` whenever `req.identity.exafy_admin`, with no reference to MT_RESOLUTION_V2."
  Task: `tenant-admin-api` A2.
  Acceptance: `test/mt-tenant-admin-scope-helper.test.ts` covers these cases:
  - Exafy-admin with env `{}` → own tenant.
  - Exafy-admin with `{ MT_RESOLUTION_V2: 'true' }` → `{ scope: 'all' }`.
  - Tenant-admin → `targetTenantId` in both modes.
  - A supertest on `GET /listings` with the flag off asserts `fetchAdminListingsQueue` received the own tenant (the
    `.eq` applied). With the flag on it received `null` (no `.eq`).
  The cases are red on `origin/main`.
- R3-F2 [minor], verbatim: "The scope-helper guard test enumerates an 'explicit list of files this lane owns' and fails
  only when those listed files read identity.tenant_id / targetTenantId directly. This is an allowlist, not a
  structural rule: any future scoped handler added outside the enumerated list (or a rename/refactor) silently
  escapes the guard, re-introducing the exact divergent-local pattern the spec is trying to eliminate."
  Task: `tenant-admin-api` A2 and the guard test.
  Acceptance:
  - The guard test selects files by import of `middleware/require-tenant-admin` (glob), not by list.
  - A fixture importer that reads `identity.tenant_id` makes it fail.
  - Removing a direct read from a baseline file, while leaving the file listed, makes it fail.
  - It is red on `origin/main`, where `admin-autopilot.ts` and `admin-community-marketplace.ts` read directly
    and are not in the baseline.
  - The baseline holds only files this lane does not convert.

