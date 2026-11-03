# Requirements — mt-m3 (M3 generally provisionable) — mt-m3-r2 (re-plan)

Program: `docs/MULTI-TENANT-PLAN.md` v5.1, §6 "Deferred to M3" + §7 milestone **M3** + §4.1/§4.8. This spec links the
program records; it does not copy them.

## Program position
- **Predecessors (done, in production):** VTID-05147 (S-M), VTID-05149 (A: `tenants.is_default`/`is_platform`,
  `TenantContext`, `ci_tenant_isolation_health()`), VTID-05150 (B: `provision_tenant`, admin-tenants API + readiness +
  assets), VTID-05151 (C: `resolve_tenant`, public registry, DB-driven `useTenant`). Records:
  `docs/validation/VTID-0514{7,9}/**`, `docs/validation/VTID-0515{0,1}/**`, `docs/multitenancy/MIGRATION-QUEUE.md`.
- **Cross-spec:** **mt-tenant-admin** owns deactivate/archive (O2); **mt-network** owns Network groups; **mt-identity**
  supplies `tenant_id_for_policies()`/`TenantContext` (the gateway membership check is VTID-05043
  `lookupTenantMembership()`); **mt-frontend-brand** already reads `tenant_domains` hosts for the
  CORS allowlist (this spec creates that table).
- **This spec (M3):** the deferred "generally provisionable" items — custom-domain plumbing (`tenant_domains`, host
  resolution, AASA/assetlinks per-domain release handling), member tenant switching UI, per-tenant monitoring, ERP
  auto-bootstrap, provisioning-wizard polish, D2/D9-bounded price-display de-hardcoding, and the offboarding runbook
  (reference only).

## Requirements (EARS)

### R1 — Custom-domain resolution (lanes `tenant-domains-db`, `host-resolution-gw`)
1. THE SYSTEM SHALL store verified custom domains in `tenant_domains(tenant_id, host, is_primary, verified_at)` with a
   unique host, FK to `tenants`, and RLS that permits no client read/write (service-role / exafy-admin only).
2. THE `resolve_tenant` RPC SHALL resolve a host ONLY when a matching `tenant_domains` row has `verified_at IS NOT NULL`,
   and SHALL resolve it THROUGH `_tenant_public_registry()` so the active + non-platform filter still applies; an
   unverified host, or a host on an inactive or platform tenant, SHALL resolve to nothing and fall through to the
   existing slug arm. A host that collides with a reserved slug SHALL be rejected at write time. The host arm SHALL NOT
   add any `tenant_domains` column to the returned set — the Lane C 8-column whitelist is unchanged.
3. WHEN the gateway resolves a request THE host arm SHALL run before the token and primary arms and SHALL set tenant context
   only; data access SHALL still require membership (host tenant ≠ member → the existing join posture, never a silent
   default). Because the host arm only sets context, an unverified/inactive/platform host MUST resolve empty at the DB
   (R1.2) rather than relying on the membership check, which gates data, not which tenant the context is set to. Dark
   behind `MT_RESOLUTION_V2`.

### R2 — Member tenant switching UI (lane `tenant-switcher-ui`) — D8
1. WHEN a member belongs to ≥2 tenants THE SYSTEM SHALL show a community switcher listing their own memberships and
   switch via the existing `setTenantBySlug()` (`switch_to_tenant_by_slug` RPC + `refreshSession()`); no new switch
   mechanism.
2. FOR a single-tenant member THE switcher SHALL NOT render. It SHALL NOT be exafy-admin-gated (distinct from
   `TenantManagement`); every string SHALL come from `src/i18n/{de,en}/…` DE-first du-form; layout SHALL follow Spotlight
   (tokens, logical start/end) and work in RTL.

### R3 — Native custom-domain readiness (lane `native-domains-aasa`) — §4.8
1. THE SYSTEM SHALL keep one `vitanaland.com` AASA/assetlinks set covering every path-slug tenant.
2. A custom domain that needs native reach SHALL be documented as requiring an app release whose associated-domain
   entitlements list that host; a guard test SHALL prevent silently assuming universal-link coverage for a new host.

### R4 — ERP auto-bootstrap + per-tenant monitoring (lanes `provision-erp-monitoring-db`, `monitoring-erp-gw`, `morning-health-pertenant`)
1. WHEN a tenant is provisioned THE `provision_tenant()` RPC SHALL idempotently record an ERP bootstrap request as the
   governed flag `feature_flags.erp.bootstrap_requested` (a tenant-admin merge cannot erase it); acting on it is a
   separate ERP-bootstrap spec.
2. THE SYSTEM SHALL provide `ci_tenant_isolation_health_by_tenant()` returning the existing isolation counts per tenant,
   summing to `ci_tenant_isolation_health()`; `ci_tenant_isolation_health()` SHALL be unchanged.
3. THE admin health read SHALL surface the per-tenant counts, and `MORNING-SYSTEM-HEALTH-CHECK.yml` SHALL report them
   (read-only, report-only). The workflow edit is a governance-path change (`executor: kiro (reviewer agent)`).

### R5 — Wizard polish, price-display de-hardcoding, offboarding runbook (lane `wizard-price-polish`) — D2/D9, O2
1. THE provisioning wizard (on VTID-05221's panel) SHALL gain readiness affordances, a custom-domain field feeding
   `tenant_domains`, and clearer step errors.
2. Price/currency DISPLAY SHALL read a tenant's `tenant_settings.currency` instead of a hardcoded constant; THE SYSTEM
   SHALL NOT add per-tenant pricing, wallet, plans or invoicing (D2/D9).
3. THE SYSTEM SHALL provide `docs/multitenancy/RUNBOOK-offboarding.md` referencing mt-tenant-admin-r2's deactivate/archive
   RPCs (reference only; no RPC defined here).

## Not in this spec
Deactivate/archive implementation (mt-tenant-admin-r2 O2), Network groups and Network scope (mt-network), per-tenant money
beyond currency display (wallet/plans/Stripe/tax/invoices/coupons), per-tenant navigation, per-tenant voice persona,
white-label app builds, and actual store submission / DNS cutover (owner-gated native release).
