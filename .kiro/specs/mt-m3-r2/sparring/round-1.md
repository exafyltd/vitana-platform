# Sparring round 1 — in_progress

Session: `2c303e22-d7d8-4584-bc0c-efcd0193f9b6` · plan hash `280ce2ce6bacd8b5c1e0ec84ce57feb5e936bd823837cc2e22357dc047e43dc6`

## Summary

Verified 10+ premises against the pinned code. The gateway-side claims (getTenantContext signature/behavior, TenantSource union, lookupTenantMembership cache semantics, admin-health route locations, erp-bridge-client interface, resolve_tenant SQL function) all hold. One material performance gap found in the host-resolution hot-path analysis: the plan doesn't account for the uncached membership-check cost for non-member users on host-based tenants. Unable to verify the v1 frontend premises and two DB migration premises (tenant_settings_merge_feature_flags, provision_tenant INSERT) due to the tool-call cap; these should be confirmed in the next round.

## Findings

### R1-F1 [major]

The hot-path budget for host resolution is incomplete: lookupTenantMembership has no negative cache (not_member/unavailable are never cached), so every request from an authenticated non-member visiting a host-based tenant incurs an uncached DB call that the plan's latency analysis omits. Once MT_RESOLUTION_V2 is on, any authenticated user landing on a custom-domain tenant they haven't joined pays a per-request membership DB round-trip (resolve host → cached OK, then lookupTenantMembership → not_member → DB, then fall-through to token arm → possibly another lookupTenantMembership for a different tenant). The current token arm rarely hits the non-member path in practice; host resolution makes it the common case for public community landing pages.

- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:531` — async function lookupTenantMembership(userId: string, tenantId: string): Promise<MembershipLookup> {
    const key = `${userId}:${tenantId}`;
    const cached = tenantMembershipCache.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > Date.now()) return 'member';
      tenantMembershipCache.delete(key);
    }
    ...
    if (!data) return 'not_member';
    tenantMembershipCache.set(key, { ... });
    return 'member';
- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:635` — export async function getTenantContext(req: AuthenticatedRequest): Promise<TenantContext | null> {
  ...
  if (identity.tenant_id) {
    if (!identity.exafy_admin) {
      const lookup = await lookupTenantMembership(identity.user_id, identity.tenant_id);
      if (lookup !== 'member') return null;
    }
    ...
  }
  const primary = await resolvePrimaryTenantForRequest(identity.user_id);

Suggestion: Add a short-TTL negative cache (e.g. 15-30 s) for the host-arm membership check, or skip the membership check entirely in the host arm (context-only: the host arm sets TenantContext.source='host' for UI display, but actual data-mutating routes already enforce membership via requireTenant/applyTenantMembershipResult). Either way, document the expected per-request DB-call count for the non-member-on-host case in the hot-path budget section so a reviewer can judge the trade-off.

### R1-F2 [minor]

The plan references several vitana-v1 file:line premises (useTenant.tsx:170, TenantManagement.tsx:150, App.tsx:2158, permissions.ts:24, TenantPortal.tsx:178-193, tenant-registry.ts:219, apple-app-site-association) and two platform migration premises (tenant_settings_merge_feature_flags at 20261014000400:175-193, provision_tenant INSERT at 20261014000500:154-165) that could not be verified in this round due to tool-call limits. These are load-bearing for lanes 3, 5 and 8 (switcher UI, ERP flag governed-key protection, wizard polish).

- `exafyltd/vitana-platform:supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql:133` — CREATE OR REPLACE FUNCTION public.resolve_tenant(p_slug text)
RETURNS TABLE (
  tenant_id    uuid,
  slug         text,
  name         text,
  display_name text,
  open_signup  boolean,
  brand        jsonb,
  landing      jsonb,
  locales      jsonb
)

Suggestion: In the next round the planner should confirm (or the reviewer should verify): (a) tenant_settings_merge_feature_flags() body and its governed-key drop list at the cited lines, (b) provision_tenant ON CONFLICT clause, (c) at least the v1 tenant-registry.ts:219 named-arg call that proves the 1-arg overload binding claim. If any premise is stale the affected lane's design must be updated.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
