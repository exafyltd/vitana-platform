---
change_class: standard
---
# plan(mt-m3): M3 generally-provisionable — custom domains, tenant switching UI, monitoring, ERP bootstrap, offboarding runbook — mt-m3-r2 (re-plan)

<!-- plan:begin -->
## Re-plan answers (session `8a83bc72` round 3)
Re-plan of `mt-m3` (branch `kiro/mt-m3/plan`; PLAN-SPAR session `8a83bc72` escalated at the round cap). Every premise
was re-verified on platform `origin/main` `62990ce285` and vitana-v1 `58c76c956` on 2026-11-01.
- **R3-F1** (`getTenantContext()` cannot answer 503): accepted with option (a). It returns `TenantContext | null`
  (`auth-supabase-jwt.ts:635`), and the token arm returns `null` on any non-member lookup (`:642`). The 503 at
  `:671-679` belongs to `requireTenant`/`applyTenantMembershipResult`, not to this function.
  - On the host arm, a host-tenant lookup of `not_member` or `unavailable` contributes nothing. Resolution falls
    through to the unchanged token arm, then the primary arm. The signature is unchanged, and `getTenantContext` never
    writes a response.
  - The "join" posture for a non-member host stays a frontend concern (the switcher UI lane).
  - Test (`test/mt-m3-host-resolution.test.ts`), with `MT_RESOLUTION_V2` on and a custom host mapped to tenant X:
    - `lookupTenantMembership` returns `unavailable` for X. The result is the token tenant with `source: 'token'`,
      and `res.status` is never called.
    - It returns `member`. The result has `source: 'host'`.
    - Both cases are red on `main`, where there is no host arm and no `'host'` `TenantSource`.
- **R3-F2** (the admin health route was not pinned): accepted. Lane 6 adds a new route on one line,
  `router.get('/health/tenant-isolation', requireAdminAuth, …)` in `routes/admin-health.ts`. It follows the file's
  one-line convention so the impact-scan rule `new-route-without-auth-middleware` sees the gate.
  - The public `/health` (`:63`), `/build-info` (`:74`) and `/health-registry` (`:113`) stay byte-identical.
  - Test: without an admin token the route answers 401/403. With one, it returns the per-tenant counts and the
    `erp.bootstrap_requested` flags.
  - A snapshot of the `/health` JSON keys is unchanged.
  - The route test is red on `main` (404).
- **Stale premises corrected:**
  - `20261101` is no longer empty. `main` has `20261101110000`/`110100` (mt-launch), and MIGRATION-QUEUE has 11 rows
    (row 11 is vitana-v1 `20261101090000`).
  - `erp-bridge-client.ts` `execute` is at `:46`.
- **Migration versions:** day-shifted with every multi-tenant re-plan (`20261101HHMMSS` → `20261102HHMMSS`):
  `20261102140000`, `140100`, `141000`, `141100`. The `20261102*` range is free, and these sort after
  `mt-tenant-admin-r2`'s `070xxx` rows. QUEUE rows are appended after the current last row.
- **Lanes on today's rules:**
  - `morning-health-pertenant` edits `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml`. That is a governance path
    but not a protected gate file. The lane moves from `executor: claude` to `executor: kiro` with `reviewer_seat:
    agent:vitana-lane-reviewer` (`collaboration.md` §3a). Claude Code is retired.
  - Every lane is `next_actor: kiro` and is reviewed by the reviewer agent.
  - Migrations are applied by Kiro through `RUN-MIGRATION.yml`, only after the owner approves the files and the target
    database (§7d).

## Problem
Program `docs/MULTI-TENANT-PLAN.md` v5.1 §6 "Deferred to M3" + §7 milestone **M3** ("deferred items per decisions;
wizard polish; offboarding runbook; per-tenant monitoring") and §4.8. Verified on platform/v1 `origin/main`.
Predecessors S-M/A/B/C are live (VTID-05147/05149/05150/05151).

1. **No host-based tenant resolution exists.** The program chain starts `host (tenant_domains.host) → …` (§4.1) but
   there is no `tenant_domains` table (0 hits in `supabase/migrations/**`) and no host arm in the gateway:
   `services/gateway/src/middleware/auth-supabase-jwt.ts` resolves tenant only from the JWT `active_tenant_id` claim
   (`:283`) with a `user_tenants` fallback; `req.hostname` is used only for CORS/affiliate parsing, never resolution.
   `resolve_tenant` (VTID-05151) takes a slug only.
2. **No member-facing tenant switching UI (D8: "switching UI in M3").** v1 `src/hooks/useTenant.tsx` has
   `setTenantBySlug()` (`:170`; `switch_to_tenant_by_slug` RPC `:190` + `refreshSession()` `:208`).
   `src/pages/admin/TenantManagement.tsx` is an admin route (`App.tsx:2158`, `requiredRole="admin"`) with an exafy-admin
   switch section (`:150`); `canSwitchTenant` = `exafy.admin` + `tenant.switch` (`src/lib/permissions.ts:24`). A normal
   dual member has no switch UI. The portal flow (`TenantPortal.tsx:178-193`) is joining, not switching.
3. **Custom domains are not deliverable natively.** AASA ships one appID `62Q26QSEJW.com.exafy.maxina` with `paths:["*"]`
   (`vitana-v1/public/.well-known/apple-app-site-association`) and one `assetlinks.json`; §4.8/D5 say a custom domain
   needs associated-domain entitlements compiled into the binary (an app release per domain), and the single
   AASA/assetlinks set covers every tenant only while they live under `vitanaland.com/<slug>`.
4. **`provision_tenant()` records no ERP bootstrap.** `supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql`
   has no §4.6 "ERP bootstrap request" (`erp`/`bootstrap` = 0 hits); a new tenant is not ERP-enrolled.
5. **Monitoring is not per-tenant.** `ci_tenant_isolation_health()` (`20261014000300_vtid_05149_…`) is wired
   report-only into `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` and returns global counts only.
6. **Price/currency are provisioned once, never per-tenant overridable (D2/D9).** `provision_tenant` writes a single
   `tenant_settings.currency` (`:155`); D2 permits de-hardcoding the price-DISPLAY read path only (one shared VTNA
   wallet, shared plans/prices, no invoicing) — no per-tenant economy.
7. **No offboarding runbook.** Deactivate/archive is **owned by mt-tenant-admin** (O2; unmerged
   `kiro/mt-tenant-admin/plan`, `deactivate_tenant(slug)`/`archive_tenant(slug)`). mt-m3 writes only the **runbook**,
   naming those RPCs, with a documented TODO if mt-tenant-admin-r2 has not merged.

Network groups (D27) are owned by mt-network and are explicitly **not** planned here (CROSS-SPEC "Network groups").

## Fix
Dark by default via `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*` unless named (§4.7, §8). Lanes:

1. **`tenant-domains-db` (DB, vitana-platform).** New `tenant_domains(tenant_id fk, host citext unique, is_primary,
   verified_at, created_at)`, RLS service-role/exafy-admin only (no client writes), host format CHECK. "No host equal to
   a reserved slug" cannot be a CHECK (it reads the table `reserved_tenant_slugs`, `20261014000400_…:129,140`), so it is
   a `BEFORE INSERT OR UPDATE OF host` trigger `tenant_domains_reject_reserved()` raising when `EXISTS (SELECT 1 FROM
   reserved_tenant_slugs r WHERE r.slug = lower(btrim(NEW.host)))`; rollback drops trigger + fn with the table. Add the program's `resolve_tenant(host, slug)` (§4.1) as a SEPARATE 2-arg overload
   `resolve_tenant(p_host text, p_slug text)` with NO parameter DEFAULTs, so a 1-arg or `{p_slug}`-only call can only bind
   the untouched VTID-05151 `resolve_tenant(p_slug text)` (`20261014000600_…:133`; its only caller is v1
   `src/lib/tenant-registry.ts:219`, named `{ p_slug }`; the gateway has none). It resolves a host ONLY when
   `verified_at IS NOT NULL` and ONLY through `_tenant_public_registry()` (filters `is_active AND is_platform = false`,
   `:74-77`), else delegates to the 1-arg slug function — unverified/inactive/platform host → empty. Same 8-column
   return as the 1-arg (Lane C whitelist), same grants. Rollback drops only the 2-arg overload. Expand-only.
2. **`host-resolution-gw` (gateway code).** Add a host arm to `TenantContext` resolution
   (`services/gateway/src/services/tenancy/tenant-context.ts` + the middleware read in `auth-supabase-jwt.ts`): resolve
   `req.hostname` through `resolve_tenant(host,…)` as a NEW FIRST arm of `getTenantContext()`
   (`auth-supabase-jwt.ts:635-650`; today token arm `:639-646` → primary `:647-649`, no slug/claim arm), ahead of
   the unchanged arms. Membership re-check of the host tenant reuses VTID-05043 `lookupTenantMembership()` (`:531`;
   60s positive cache, no negative cache; `not_member` / `unavailable` → the host arm contributes nothing and
   resolution falls through to the token then primary arm — `getTenantContext` returns `TenantContext | null` and never
   answers 503, R3-F1), no new RPC; exafy_admin skip as `:640`;
   `not_member` → the frontend's existing "join" posture (switcher UI), not a gateway response. This adds `'host'` to the
   `TenantSource` union (`tenant-context.ts:22`, today `'token' | 'exafy_admin_token' | 'primary' |
   'membership_fallback'`); the lane audits every `TenantSource` consumer in the gateway (the type is referenced in
   `auth-supabase-jwt.ts:35,579,607,617` — `PrimaryTenantOutcome`, `tokenTenantOrigin`) and adds the `'host'` case so
   TypeScript still compiles. **Hot-path budget** (the middleware runs on every request, `AUTH_LOOKUP_TIMEOUT_MS=2500`,
   `auth-supabase-jwt.ts:63-69`): the lookup fires ONLY when `MT_RESOLUTION_V2` is on AND `req.hostname` is not a
   platform host (`vitanaland.com` + subdomains, `localhost`, staging/ALB hosts — one constant in `tenant-context.ts`),
   so the default path-slug case pays nothing; results (hits AND misses) go in a bounded host→tenant cache with the
   60s TTL of `tenantMetaCache` (`tenant-context.ts:66-86`); the RPC uses the existing `abortAfter(AUTH_LOOKUP_TIMEOUT_MS)`
   (`:71`) — timeout/error → logged, host arm yields nothing, next arm runs (context only; data still needs membership).
   Depends on `tenant-domains-db`.
3. **`tenant-switcher-ui` (vitana-v1, frontend).** A member-facing community switcher for members of ≥2 tenants: list
   the member's own memberships from `useMemberships()` (`list_my_memberships`, not the public registry — registry only
   resolves slug/brand for display), call the existing `setTenantBySlug()` (reuse `switch_to_tenant_by_slug` +
   `refreshSession`, no new mechanism). Hidden for single-tenant members. Not exafy-admin-gated (that is
   `TenantManagement`); gated on "member of >1 tenant". Spotlight tokens, logical start/end, i18n DE-first du-form, RTL.
   Mounted in Settings (no new route → no nav registry/manifest/parity change; a new route adds those rows in-lane).
4. **`native-domains-aasa` (vitana-v1, native).** Keep the single `vitanaland.com` AASA/assetlinks set for path-slug
   tenants; document the per-domain release requirement (§4.8) — a `tenant_domains.host` with `verified_at` needing
   native reach requires an app release whose entitlements list that domain. Add a generation note + a test that the
   committed files stay valid and that a custom domain is not silently assumed to have universal-link coverage. No store
   submission here (governed native release).
5. **`provision-erp-monitoring-db` (DB, vitana-platform).** (a) Extend `provision_tenant()` to record the §4.6 ERP
   bootstrap request as `tenant_settings.feature_flags.erp.bootstrap_requested=true`, idempotent. The existing
   `tenant_settings` INSERT uses `ON CONFLICT (tenant_id) DO NOTHING` (`20261014000500_…:154-165`), so a flag written
   only inside that INSERT would never be recorded on a re-run for an already-provisioned tenant. The lane therefore
   adds, AFTER that INSERT, a guarded `UPDATE tenant_settings SET feature_flags = jsonb_set(feature_flags,
   '{erp,bootstrap_requested}', 'true'::jsonb, true) WHERE tenant_id = v_tid AND NOT (feature_flags #>
   '{erp,bootstrap_requested}' = 'true'::jsonb)`, so first-run and re-run both end with the flag set exactly once.
   `erp` becomes a **governed key** like `jev`: the same migration re-creates `tenant_settings_merge_feature_flags()`
   (`20261014000400_…:175-193`, top-level `||` merge) dropping `- 'jev' - 'erp'` for `p_allow_governed = false`, so a
   tenant-admin PUT cannot replace/erase it (rollback restores the `jev`-only body).
   (b) add `ci_tenant_isolation_health_by_tenant()` returning the existing counts grouped per tenant; expand/contract,
   rollback, pre/post checks, QUEUE rows; `ci_tenant_isolation_health()` unchanged (reused).
6. **`monitoring-erp-gw` (gateway code, display-only).** On a NEW admin-gated route
   `router.get('/health/tenant-isolation', requireAdminAuth, …)` in `services/gateway/src/routes/admin-health.ts`
   (one line through `requireAdminAuth`, R3-F2; the public `/health`, `/build-info`, `/health-registry` unchanged) surface the per-tenant isolation counts AND, per tenant, whether
   `feature_flags.erp.bootstrap_requested` is set — read-only, dark behind the flag. **No ERP action is dispatched:** the
   erp-bridge is an execute-only client (`backoffice/erp-bridge-client.ts:17,46`, `execute(req)`) with no bootstrap
   concept, so a consumer is a separate ERP-bootstrap spec (deferred). Depends on `provision-erp-monitoring-db`.
7. **`morning-health-pertenant` (governance, executor: kiro, reviewer agent).** One edit to
   `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` to also report the per-tenant breakdown (report-only, read-only).
   `.github/**` is a governance path (collaboration §3a / queue.mjs `GOVERNANCE_PATHS`), not a protected gate file, so this lane is `executor:
   kiro` with `reviewer_seat: agent:vitana-lane-reviewer` (§3a). Depends on `provision-erp-monitoring-db`.
8. **`wizard-price-polish` (vitana-v1, frontend).** Wizard polish on VTID-05221's panel (readiness affordances,
   custom-domain field feeding `tenant_domains`, clearer step errors); D2/D9-bounded price/currency **display**
   de-hardcoding (render from `tenant_settings.currency`, NOT a hardcoded constant; no per-tenant pricing/wallet/
   invoicing); offboarding/archive **runbook** (`docs/multitenancy/RUNBOOK-offboarding.md`) referencing mt-tenant-admin-r2's
   O2 RPCs (reference only). i18n DE-first du-form, Spotlight, RTL.

## Migrations
Range **20261102140000–20261102145959** (free: no `20261102*` migration exists; `20261101` holds only mt-launch `110000`/`110100`). Files:
- `20261102140000_vtid_*_mt_tenant_domains.sql` (+ `..._rollback.sql`) — lane `tenant-domains-db`.
- `20261102140100_vtid_*_mt_resolve_tenant_host.sql` (+ rollback) — lane `tenant-domains-db` (2-arg overload).
- `20261102141000_vtid_*_mt_provision_erp_request.sql` (+ rollback) — lane `provision-erp-monitoring-db` (+ merge fn).
- `20261102141100_vtid_*_mt_isolation_health_by_tenant.sql` (+ rollback) — lane `provision-erp-monitoring-db`.
MIGRATION-QUEUE: the queue has 11 rows (row 11 = vitana-v1 `20261101090000`); **append after the current last row with an mt-m3
header range note**; the `1102140000+` range sorts after any mt-tenant-admin-r2 `070xxx` rows, so no re-position is needed.
Each file ships read-only pre/post-check SQL; `migration-drift-baseline.json` carries the not-yet-live `tenant_domains`
until apply. Expand/contract; `lock_timeout` + retries; applied by Kiro via RUN-MIGRATION, only on the owner's approval of the files and the target database (§7d).

## Tests
- pgTAP (DB lanes): `tenant_domains` RLS (b_member/anon no read/write; exafy-admin/service only); the
  2-arg `resolve_tenant(p_host, p_slug)` resolves a VERIFIED host, falls back to slug, resolves EMPTY for an
  unverified host or an inactive/platform tenant's host; the trigger rejects INSERT/UPDATE of a reserved-slug host; the legacy 1-arg
  `resolve_tenant(p_slug)` output is byte-identical before/after and a `{p_slug}`-only call binds it; both return the
  same 8 columns (no `tenant_domains` column). `provision_tenant` records the ERP request idempotently on first-run AND
  re-run; a `p_allow_governed=false` merge sending `erp` does not erase it; `ci_tenant_isolation_health_by_tenant()`
  sums to `ci_tenant_isolation_health()`.
- Jest/Vitest (gateway): host arm runs before token/primary; contract test: the host tenant_id goes through
  `lookupTenantMembership` (repeat hits its cache, no other membership query; `not_member` / `unavailable` → falls through to token/primary, `res.status` never called — R3-F1); the
  `/health/tenant-isolation` route is admin-gated (401/403 without admin) and `/health` keys unchanged (R3-F2);
  no lookup for a platform host or flag off; host-cache hit skips the RPC; timeout falls through; per-tenant health + ERP-flag shape, no ERP bridge call. `npm run test:support` +
  `npm run test:operator` stay green (42c/42e) if touched.
- Vitest (v1): switcher lists only the member's memberships, hidden for single-tenant members, calls `setTenantBySlug`;
  AASA/assetlinks validity + custom-domain universal-link guard; price render reads tenant currency; wizard custom-domain
  field posts to `tenant_domains`. ESLint i18n + design clean on new files; `npm test` (nav registry/design manifest).
- Golden: Maxina surfaces byte-identical where touched (rule 41 — spoken output not compared).

## Staging verification
Read-only (rule 48). v1 staging specs sign in as the test user and assert: the switcher is absent for a single-tenant
member; the admin host/domain field renders; a network guard aborts every non-GET. Gateway host-arm and per-tenant
health proven by Jest only (no custom domain or multi-tenant member on staging; staging uses production Supabase). No
suite targets production.

## Rollout
Dark by default (`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`). DB applied by Kiro via RUN-MIGRATION in
QUEUE order after merge, only on the owner's approval of the files and the target database (§7d). **Owner-only:** pointing a custom domain / shipping a per-domain native release is a governed
native release + DNS step, named here, not done by a lane. Deactivate/archive execution stays with mt-tenant-admin;
this spec adds only the runbook.

## Risks
- Host resolution opening a cross-tenant path. Mitigation: context only; `lookupTenantMembership` on the host tenant;
  contract test.
- `resolve_tenant` overload confusing VTID-05151 callers. Mitigation: 1-arg untouched; no-DEFAULT 2-arg overload;
  legacy output pinned; `'host'` in `TenantSource` audited.
- Host lookup stalling every request. Mitigation: platform-host skip, flag gate, 60s cache, `abortAfter` (Fix #2).
- Custom-domain expectation outrunning native reality. Mitigation: runbook + guard test make the per-domain release
  explicit; no silent universal-link claim.
- Price de-hardcoding drifting into a per-tenant economy. Mitigation: display-only, D2/D9 fenced, review checks no
  wallet/plan/invoice change.

## Out of scope
- Deactivate/archive implementation (mt-tenant-admin, O2) — runbook reference only.
- Network groups (mt-network) and any Network-scope work.
- Per-tenant money beyond currency-display de-hardcoding: wallet, plans, Stripe accounts, tax, invoices, coupons (M3+ /
  D2/D9).
- Per-tenant navigation, per-tenant voice persona, white-label app builds, actual store submission.
- Any consumer that acts on `erp.bootstrap_requested` (ERP bridge dispatch) — a separate ERP-bootstrap spec.

## Depends on
- Specs: **mt-tenant-admin** (O2 RPCs, unmerged sibling — runbook reference only, see Problem #7). **mt-identity**
  for `TenantContext`; membership re-check = VTID-05043 `lookupTenantMembership()` (Fix #2), not `is_member()`. **mt-frontend-brand** (its CORS allowlist reads
  `tenant_domains` hosts; recorded, not a front-matter `depends_on`).
- Done: VTID-05147 (S-M), VTID-05149 (A: `is_default`/`is_platform`, `TenantContext`, `ci_tenant_isolation_health()`),
  VTID-05150 (B: `provision_tenant`, admin-tenants API), VTID-05151 (C: `resolve_tenant`, public registry, `useTenant`).
- Within this spec: `host-resolution-gw` depends on `tenant-domains-db`; `monitoring-erp-gw` and
  `morning-health-pertenant` depend on `provision-erp-monitoring-db`; `wizard-price-polish` depends on
  `tenant-domains-db` (custom-domain field).

## Owner decisions
D5 (custom domains later, per-domain app release), D8 (switching UI in M3), D2/D9 (one wallet, shared prices, no
invoicing — price work is display de-hardcoding only) are DECIDED; applied, not re-argued. No new owner decision; custom
domain go-live and native release remain owner-gated steps named under Rollout.
<!-- plan:end -->

## Open questions for sparring
- Settled (round 1, R1-F3): `resolve_tenant(p_host, p_slug)` is a separate no-DEFAULT 2-arg overload; the 1-arg slug
  function is untouched. Cross-spec with mt-frontend-brand (CORS allowlist reads `tenant_domains` hosts).
- Settled (round 1, R1-F1/F4): the ERP request is a governed `feature_flags.erp.bootstrap_requested` flag, displayed
  only; acting on it is a separate ERP-bootstrap spec.
