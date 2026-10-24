# Sparring round 1 — in_progress

Session: `8a83bc72-709d-4234-8481-0e260cd2771f` · plan hash `e85eeb47a88b6fda3beccd7ea7eb8c88025a493ddc1c5d7ce90677efb71853f8`

## Summary

The plan is well-grounded against the code. I verified most premises and they hold: no tenant_domains table; resolve_tenant(p_slug text) today; provision_tenant has no ERP bootstrap and uses ON CONFLICT DO NOTHING for tenant_settings INSERT (line 154-164); ci_tenant_isolation_health() returns global counts only; tenant_settings.currency exists (default EUR); the TenantSource union is exactly 'token'|'exafy_admin_token'|'primary'|'membership_fallback' (tenant-context.ts:22); MORNING-SYSTEM-HEALTH-CHECK 21b is report-only INFO. I could not read vitana-v1 (no pinned ref in this session), so frontend claims (useTenant.tsx setTenantBySlug, permissions.ts canSwitchTenant, TenantPortal/TenantManagement line numbers) are unverified against code. I found several real gaps: (1) the ERP bootstrap-request consumer in lane 6 is underspecified relative to the actual erp-bridge (the plan invents a "flag → ERP path" wiring with no named function/caller, and erp-bridge is an execute-only HTTP bridge with no bootstrap concept); (2) the guarded UPDATE after the INSERT interacts with tenant_settings_merge_feature_flags governance (the `||` merge means a tenant-admin PUT could later clobber/merge the erp flag — but more importantly the plan's UPDATE is fine, though the 'erp' key is not in the governed whitelist unlike 'jev'); (3) resolve_tenant host-first signature change creates an overload ambiguity risk for existing resolve_tenant(text) callers and the plan does not pin which signature the existing callers still hit; (4) the host arm adds a DB round-trip on every authenticated request (perf/governance: AUTH_LOOKUP_TIMEOUT_MS=2500 budget) which is not addressed; (5) migration range claim verified but the plan references two migration files in one lane without clarity on QUEUE row ordering for the resolve_tenant host extension.

## Findings

### R1-F1 [major]

Lane 6 (monitoring-erp-gw) says it 'wires the ERP bootstrap-request consumer into the BackOffice ERP path', but the plan never names which function/route reads tenant_settings.feature_flags.erp.bootstrap_requested and drives an ERP action. The actual erp-bridge has no 'bootstrap' concept: it is an execute-only HTTP client (erp-bridge-client.ts: execute(req) for arbitrary action/params with idempotency_key). There is no existing 'ERP bootstrap' request or consumer to wire into, so this lane is effectively inventing a new feature whose spec is absent — a member-facing auto-enrolment that could trigger ERP side effects per new tenant.

- `exafyltd/vitana-platform:services/gateway/src/services/backoffice/erp-bridge-client.ts:17` — export interface BridgeExecuteRequest { tenant_id: string; action: string; params: Record<string, unknown>; idempotency_key: string; actor: {user_id...}; confirmation?: BridgeConfirmation; }
- `exafyltd/vitana-platform:supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:154` — INSERT INTO public.tenant_settings (...) VALUES (...) ON CONFLICT (tenant_id) DO NOTHING;

Suggestion: Lane 6 must name the concrete consumer (which gateway route/worker polls or reacts to the erp.bootstrap_requested flag, and which bridge action it dispatches), or descope lane 6 to a display-only surface of the flag (report the flag, no ERP action) until a separate ERP-bootstrap spec exists. As written, 'wire into the BackOffice ERP path' is unverifiable and over-scoped for the declared standard change class.

### R1-F2 [major]

The host-resolution DB round-trip is added to resolvePrimaryTenant/tenant-context resolution which runs on every authenticated and optionally-authenticated gateway request under a 2500ms timeout budget (AUTH_LOOKUP_TIMEOUT_MS, auth-supabase-jwt.ts:69). The plan's host arm adds another Supabase call (resolve_tenant(host,...)) on the hot path with no caching, no timeout/abort wiring, and no mention of the performance budget or the existing 60s tenant-meta cache pattern. A slow host lookup could stall every request exactly as the VTID-03972 comment warns against.

- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:63` — this middleware runs on every authenticated/optionally-authenticated gateway request ... AUTH_LOOKUP_TIMEOUT_MS = 2500
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:22` — export type TenantSource = 'token' | 'exafy_admin_token' | 'primary' | 'membership_fallback';

Suggestion: Specify the host arm's caching (reuse the 60s tenantMetaCache pattern or a host→tenant cache), its abort/timeout wiring within the 2500ms budget, and confirm the host lookup only fires when MT_RESOLUTION_V2 is on and when req.hostname is not the canonical vitanaland.com host (to avoid paying the cost for the default path-slug case).

### R1-F3 [major]

Extending resolve_tenant from a single p_slug text argument to resolve_tenant(host, slug) introduces an ambiguous/overloaded signature. The existing resolve_tenant(text) is called by vitana-v1 and the gateway for slug resolution (registry, portal join flow). A 2-arg overload with host-first semantics makes 'resolve_tenant(somestring)' still resolve as slug while 'resolve_tenant(host, slug)' resolves host — but the plan does not pin which callers keep hitting which, nor add a test that the existing single-arg callers' behavior is byte-identical. Given the program plan §4.1 explicitly names `resolve_tenant(host, slug)` as the anonymous public RPC, the risk is a caller passing a slug into the host arm (or vice versa) silently.

- `exafyltd/vitana-platform:supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql:133` — CREATE OR REPLACE FUNCTION public.resolve_tenant(p_slug text) ... WHERE r.slug = lower(btrim(p_slug))
- `exafyltd/vitana-platform:supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql:149` — SELECT r.tenant_id ... FROM public._tenant_public_registry() r WHERE r.slug = lower(btrim(p_slug))

Suggestion: Define the host arm as a distinct function name (e.g. resolve_tenant_by_host(host, slug)) OR a single text argument with explicit parameter naming, and pin in the pgTAP/contract tests that the legacy resolve_tenant(text) slug callers are unchanged. Also assert returned column whitelist is byte-identical (the plan already promises this but should tie it to a named function).

### R1-F4 [minor]

The guarded UPDATE writing feature_flags.erp.bootstrap_requested interacts with tenant_settings_merge_feature_flags()'s top-level `||` merge (tenant brand pack migration line 189-193). 'jev' is the only governed key protected for non-exafy_admin callers; 'erp' is not protected, so a later tenant-admin PUT could merge over/undefined the erp flag. Conversely the plan labels the erp flag as a §4.6 bootstrap-semantics flag but does not add 'erp' to the governed-key allowlist, so its durability against tenant-admin writes is unstated.

- `exafyltd/vitana-platform:supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:183` — feature_flags = coalesce(s.feature_flags, '{}'::jsonb) || EXCLUDED.feature_flags ... CASE WHEN p_allow_governed THEN coalesce(p_flags,'{}') ELSE coalesce(p_flags,'{}') - 'jev' END
- `exafyltd/vitana-platform:supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:159` — jsonb_build_object('jev', jsonb_build_object('enabled', true, 'planes', ...))

Suggestion: Declare whether 'erp.bootstrap_requested' is a governed key (like 'jev') that tenant-admin cannot clobber, and if so extend the merge function's governed-key allowlist (or the plan's own guarded UPDATE to re-set it), with a test showing a tenant-admin PUT does not erase the flag.

### R1-F5 [minor]

The plan asserts frontend premises against vitana-v1 with specific line numbers (useTenant.tsx:148,207 setTenantBySlug; permissions.ts:24 canSwitchTenant='exafy.admin'+tenant.switch; TenantPortal.tsx:190 join flow; TenantManagement.tsx exafy-admin gated) that I could not verify because vitana-v1 has no pinned ref available to this reviewer. These are load-bearing claims for lanes 3 and 8 (the switcher gates on existing setTenantBySlug and non-admin gating).

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:51` — (plan's own §4.1 in this repo) resolution chain ... host then path slug then JWT claim
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:60` — A native app has no hostname ... deep-link slug ... one AASA/assetlinks set covers every tenant because D5 uses path slugs

Suggestion: Not a defect in the plan per se, but flag that the vitana-v1 file:line citations (useTenant.tsx, permissions.ts, TenantPortal.tsx, TenantManagement.tsx, settings mount point, i18n/RTL/Spotlight claims) are unverified in this review round and should be re-confirmed by a reviewer with the vitana-v1 pinned ref before implementation.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
