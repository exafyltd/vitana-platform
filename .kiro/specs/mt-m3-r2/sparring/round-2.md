# Sparring round 2 — converged

Session: `2c303e22-d7d8-4584-bc0c-efcd0193f9b6` · plan hash `9d633d19b22045be0c74aa237df1fe00822bda634530d7cf6f652a93adc444ca`

## Summary

Both R1-F1 and R1-F2 were accepted by the planner and are properly addressed in the revised plan. The host-arm negative cache is well-specified (15s TTL, max 10K entries, not_member only, unavailable never cached, cleared by clearTenantMembershipCache). The per-request DB budget is documented. All previously-unverified v1/migration premises are now recorded as verified with corrected line numbers. I re-verified key premises at the pinned commit and they hold. No new blockers or major issues found. One minor item raised about the tenantMetaCache reference ambiguity.

## Findings

### R2-F1 [minor]

The plan describes the host→tenant RPC cache as using 'the 60s TTL of tenantMetaCache (tenant-context.ts:66-86)', but tenantMetaCache is a single shared object caching ALL tenant slug/isPlatform/isDefault flags (line 68: a { byId: Map, defaultId, expiresAt } struct loaded by fetchTenantFlags). The host→tenant cache needs to map individual hostnames to tenant IDs (a different cardinality and shape). The wording 'go in a bounded host→tenant cache with the 60s TTL of tenantMetaCache' could be read as 'reuse the same cache object' or 'a new cache with the same TTL'. If implementation reuses tenantMetaCache directly the shape would not fit; if it creates a new cache the parenthetical reference is misleading.

- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:66` — const TENANT_META_CACHE_TTL_MS = 60 * 1000;
const TENANT_META_TIMEOUT_MS = 2500;
let tenantMetaCache: { byId: Map<string, TenantMeta>; defaultId: string | null; expiresAt: number } | null = null;

async function loadTenantFlags(): Promise<{ byId: Map<string, TenantMeta>; defaultId: string | null } | null> {
  if (tenantMetaCache && tenantMetaCache.expiresAt > Date.now()) return tenantMetaCache;
  ...

Suggestion: Clarify in the plan that the host→tenant cache is a NEW bounded Map<string, { tenantId, expiresAt }> (or similar) in tenant-context.ts, separate from tenantMetaCache, sharing only the 60s TTL constant. This avoids an implementer accidentally trying to bolt host lookups onto the existing tenantMetaCache struct.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and well-addressed. The revision specifies a separate bounded host-arm negative cache (not_member only, 15s TTL, max 10K entries, unavailable never cached, cleared by clearTenantMembershipCache), documents the per-request DB budget for all cases, and adds specific test scenarios for the negative cache behavior. The design that the negative entry only makes the host arm contribute nothing (fall-through to token arm) is sound and prevents it from granting or denying data access.
- R1-F2: acknowledged — Accepted and properly addressed. All cited premises verified at the pinned commit: tenant_settings_merge_feature_flags at :176-194 drops only 'jev' with || merge; provision_tenant ON CONFLICT DO NOTHING at :154-164; resolve_tenant 1-arg function at :133-152. The planner corrected the off-by-one line reference and recorded all v1 verifications.
