# Design — mt-m3 (M3 generally provisionable)

## What exists (read these, do not copy them)
- Program plan + decisions: `docs/MULTI-TENANT-PLAN.md` (§4.1 resolution chain, §4.6 provisioning, §4.8 native/custom
  domains, §6 "Deferred to M3", §7 M3; D2/D5/D8/D9).
- Resolution today: `services/gateway/src/middleware/auth-supabase-jwt.ts` — tenant from JWT
  `app_metadata.active_tenant_id` (`:283`), `user_tenants` fallback; no host arm (grep: `req.hostname` used only for
  CORS/affiliate URL parsing). `services/gateway/src/services/tenancy/tenant-context.ts` builds `TenantContext`
  (VTID-05149). `resolve_tenant` (VTID-05151) takes a slug.
- Provisioning: `supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql` — writes `tenants`,
  `tenant_settings` (currency `:155`, Jev budget `:160`), groups, bot, founding, invitation; **no ERP request** (grep
  `erp`/`bootstrap` = none). API `services/gateway/src/routes/admin-tenants.ts` (GET/POST/PATCH/assets/readiness).
- Monitoring: `supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql` →
  `ci_tenant_isolation_health()`; wired report-only in `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml`.
- Switching: `vitana-v1/src/hooks/useTenant.tsx` `setTenantBySlug()` (`switch_to_tenant_by_slug` RPC + `refreshSession`,
  `:170,190,208`); exafy-admin switch section (`:150`) in the admin route `src/pages/admin/TenantManagement.tsx`
  (`App.tsx:2158`); `canSwitchTenant` (`src/lib/permissions.ts:24` = `exafy.admin` + `tenant.switch`). Portal join:
  `src/pages/portals/TenantPortal.tsx:178-193`.
- Native: `vitana-v1/public/.well-known/apple-app-site-association` (one appID `62Q26QSEJW.com.exafy.maxina`,
  `paths:["*"]`), `vitana-v1/public/.well-known/assetlinks.json`.
- Provisioning panel to polish: VTID-05221 `src/components/admin/tenant-provisioning/**`,
  `src/lib/tenant-provisioning-api.ts`, mounted in `TenantManagement.tsx` at `/admin/system/tenants`.
- deactivate/archive (reference only): `.kiro/specs/mt-tenant-admin/` lanes `tenant-lifecycle-db` + `tenant-admin-api`.

## Design per lane

### tenant-domains-db (vitana-platform, DB)
`20261101140000_…_mt_tenant_domains.sql`: `tenant_domains(id, tenant_id uuid fk tenants, host citext, is_primary bool,
verified_at timestamptz, created_at)` — unique on `host`; RLS enabled, no client policy (service-role/exafy-admin only);
host format CHECK; reserved-slug hosts rejected by a BEFORE INSERT OR UPDATE OF host trigger reading `reserved_tenant_slugs` (a CHECK cannot read another table).
`20261101140100_…_mt_resolve_tenant_host.sql`: add a separate no-DEFAULT 2-arg overload `resolve_tenant(p_host text,
p_slug text)`; the 1-arg `resolve_tenant(p_slug)` is untouched and pinned byte-identical — a verified host wins, else slug. **The host arm resolves a host ONLY when its
`tenant_domains` row has `verified_at IS NOT NULL`, and resolves it THROUGH `_tenant_public_registry()`** (the same
internal source `resolve_tenant(p_slug)` already uses, which filters `t.is_active AND is_platform = false`, verified at
`20261014000600_…:74-77`), so an unverified host, or a host on an inactive/platform tenant, resolves to nothing and the
call falls through to the slug arm. The host arm MUST NOT add any `tenant_domains` column to the returned set (D2/Rule 4).
Rollbacks `_rollback.sql`; read-only pre/post checks;
MIGRATION-QUEUE rows after the live last row (mt-m3 range note); `tenant_domains` added to `migration-drift-baseline.json` until
applied, removed in the post-apply PR. Expand-only.

### host-resolution-gw (vitana-platform, gateway code)
Host arm in `tenant-context.ts` + the middleware read: resolve `req.hostname` through `resolve_tenant(host,…)` as the new
first arm of `getTenantContext()`, ahead of the existing token and primary arms (no slug/claim arm exists); context only —
data still requires VTID-05043 `lookupTenantMembership()` on the host tenant; `not_member` → the existing join posture,
`unavailable` → 503. Dark behind
`MT_RESOLUTION_V2`. Depends on `tenant-domains-db`.

### tenant-switcher-ui (vitana-v1, frontend)
A `CommunitySwitcher` (new `src/components/tenant-switcher/**`) listing the member's **own** memberships from
`useMemberships()` (the `list_my_memberships` edge function, `vitana-v1/src/hooks/useMemberships.ts`) — NOT the public
tenant registry; the public registry (`ensureTenantRegistry`) is used only to resolve each membership's slug/brand for
display. Calls `useTenant().setTenantBySlug`. Hidden when the member has <2 memberships. Mounted
in Settings (no new route → no nav-registry/manifest/parity change; if a route is added, those rows are added in this
lane). Spotlight tokens, logical start/end, skeletons; i18n DE-first du-form; RTL. Vitest: lists only own memberships,
hidden for single-tenant, calls switch; no fetch-on-render beyond GETs.

### native-domains-aasa (vitana-v1, native)
Keep the single `vitanaland.com` AASA/assetlinks set. Add a generation/README note and a guard test asserting the
committed files stay valid and that a `tenant_domains.host` needing native reach is flagged as requiring a per-domain app
release (entitlements). No store submission.

### provision-erp-monitoring-db (vitana-platform, DB)
`20261101141000_…_mt_provision_erp_request.sql`: extend `provision_tenant()` to idempotently record the ERP bootstrap
request (a `tenant_settings.feature_flags.erp.bootstrap_requested` flag — smaller than a new table; revisit per the open
question); keeps every existing `provision_tenant` assertion.
`20261101141100_…_mt_isolation_health_by_tenant.sql`: `ci_tenant_isolation_health_by_tenant()` returning the same counts
grouped per tenant, summing to `ci_tenant_isolation_health()`. Rollbacks + pre/post checks + QUEUE rows. Expand/contract.

### monitoring-erp-gw (vitana-platform, gateway code)
Surface the per-tenant counts and, per tenant, the `erp.bootstrap_requested` flag on the existing admin health read —
display-only, no ERP bridge call (a consumer is a separate ERP-bootstrap spec). Dark behind the flag. Depends on
`provision-erp-monitoring-db`.

### morning-health-pertenant (vitana-platform, governance — executor: claude)
One edit to `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` adding the per-tenant breakdown (read-only, report-only).
`.github/**` is a governance path → `executor: claude`, `next_actor: claude`. Depends on `provision-erp-monitoring-db`.

### wizard-price-polish (vitana-v1, frontend)
Polish VTID-05221's panel: readiness affordances, a custom-domain field posting to `tenant_domains` (via the admin API),
clearer step errors. Price/currency DISPLAY reads `tenant_settings.currency` (display only — no wallet/plan/invoice
change, D2/D9). Add `docs/multitenancy/RUNBOOK-offboarding.md` referencing mt-tenant-admin's deactivate/archive RPCs.
i18n DE-first du-form; Spotlight; RTL.

## Rules every successor follows
1. **Migrations:** MIGRATION-QUEUE order, one `RUN-MIGRATION.yml` per file, applied by Claude only, with read-only
   pre/post checks; new files take the next version in 20261101140000–145959 and are queued in the same PR; a not-yet-
   live table goes in `migration-drift-baseline.json` and is removed after apply. Expand/contract; `lock_timeout`.
2. **Dark by default:** every merged code change off unless enabled (`MT_RESOLUTION_V2` + `tenant_settings.feature_flags
   .mt.*`), because PUBLISH promotes the whole staging build. No named exception in this spec.
3. **VTID-05147 AC-5** holds: no migration re-grants member writes on `user_tenants`/role tables, recreates a dropped
   policy, or redefines `set_role_preference` without the membership check.
4. **Lane C whitelist** (`docs/multitenancy/LANE-C.md`): the public registry returns only whitelisted fields; a new key
   = a new migration + harness case. `resolve_tenant` is `SECURITY DEFINER` and granted to `anon`; adding the host arg
   keeps it anon-executable, so the host arm MUST NOT add any `tenant_domains` column (host, verified_at, is_primary) to
   the returned set — the Lane C 8-column whitelist is unchanged and stays pinned by the existing harness case.
5. **Cross-spec:** deactivate/archive is mt-tenant-admin (O2) — reference only; Network groups are mt-network — not here.
6. **Production read-only** for every session and test (rules 31–32, 48); the executor never writes to Supabase/AWS
   (collaboration §7a). Creating/pointing a real custom domain and any native store release are owner-gated.
7. Test/service accounts never member-visible (rules 43–45); i18n DE-first du-form; RTL via logical properties;
   Spotlight contract; WCAG 2.2 AA.
