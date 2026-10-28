# Sparring round 2 — in_progress

Session: `0de6a378-b304-4d63-b75b-3813dfcfbf75` · plan hash `94a7ac0d2d2f275d80bd5a688a313748ef23290982c863d830930a9e3d673963`

## Summary

Round 2 review. All five round-1 findings were ACCEPTED (none rejected/deferred), and I verified the fixes landed in the revised plan: R1-F1 full path added; R1-F2 allowlist enumerated (product_analytics_events, product_analytics_daily_rollups, tenant_pack_intake, tenant_content_pipeline, tenants, get_tenant_launch_readiness); R1-F3 DEPENDENCY_NOT_READY guard on 42P01/PGRST205; R1-F4 community-invites tenant_id added but signup/referral attribution re-routed to external lane VTID-05267; R1-F5 SECURITY INVOKER + pinned search_path. I confirmed the core premises: the /claim path has no tenant_id (community-invites.ts:73-80), resolvePrimaryTenant exists and returns a tagged union (tenant-context.ts:43-64), isFeatureLive is single-arg/env-based (feature-flags.ts:81-87), admin-signups.ts:205 hardcodes DEFAULT_TENANT_ID, tenant_settings.feature_flags structure (settings.ts:36-44), and no tenant_content_overrides migration exists at this commit. Two new findings raised: (1) the signup/referral attribution fix is now fully dependent on VTID-05267 "jobs-automation-actor-tenant", which returns zero search hits at the pinned commit — unverifiable and leaves a real mis-attribution gap if it does not exist or is rejected; (2) the support-landing tenant resolution for community-invites uses identity.tenant_id from JWT app_metadata.active_tenant_id, but the route's service client (serviceClient()/service role) and resolvePrimaryTenant (getSupabase with tenant JWT) may produce inconsistent tenant resolution for the anonymous/optionalAuth claim path, and the plan does not pin which client resolves the tenant.

## Findings

### R2-F1 [major]

The revised plan offloads the signup/referral attribution fix (admin-signups.ts:205 hardcoded DEFAULT_TENANT_ID) to external lane 'jobs-automation-actor-tenant (VTID-05267)', but that VTID returns zero search hits at the pinned commit and no .kiro spec directory references it, so the dependency is unverifiable. If it does not exist or is rejected/deferred, the founding-signup mis-attribution the plan's Problem section explicitly calls out (item 5) ships unfixed.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:205` — const tenantId = process.env.DEFAULT_TENANT_ID;
        if (tenantId) {
          ... dispatchEvent(tenantId, 'user.signup.completed', ...)
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:223` — if (attempt?.utm_source === 'sharing_link' || attempt?.utm_campaign?.startsWith('share_')) {
            dispatchEvent(tenantId, 'user.signup.shared_link', {

Suggestion: Either include the admin-signups.ts tenant-resolution fix in this spec (with a documented cross-lane merge order to avoid a double edit) or, if the fix must live in VTID-05267, add an explicit acceptance dependency tracked in the plan's Depends-on section with the VTID's existence/approval verifiable at review time. The plan currently cites VTID-05267 as 'approved 2026-10-20' with no in-repo artifact; this must be validated before the plan can claim the mis-attribution gap is closed.

### R2-F2 [minor]

The support-landing tenant resolution for the /claim invite event mixes two client contexts: identity.tenant_id is read from the JWT app_metadata.active_tenant_id (auth-supabase-jwt.ts:44), while the fallback resolvePrimaryTenant uses getSupabase() which operates against the tenant's own JWT/anon scope, and the route itself creates a service-role client via serviceClient() (community-invites.ts:31). The plan does not pin which Supabase client performs the tenant resolution or what happens when active_tenant_id is a validated-but-not-primary tenant, risking a claim event attributed to a token tenant differing from the membership tenant the service-role path sees.

- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:41` — tenant_id: string | null; // From JWT 'app_metadata.active_tenant_id'
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:43` — export async function resolvePrimaryTenant(
  userId: string,
  opts?: { signal?: AbortSignal }
): Promise<PrimaryTenantResult> {
  const supabase = getSupabase(); ...
- `exafyltd/vitana-platform:services/gateway/src/routes/community-invites.ts:28` — async function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  ... return createClient(url, key, ...)
- `exafyltd/vitana-platform:services/gateway/src/routes/community-invites.ts:54` — router.post('/claim', async (req: Request, res: Response) => {
  const identity = (req as AuthenticatedRequest).identity;
  if (!identity?.user_id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

Suggestion: Pin the resolution order and client explicitly: prefer resolvePrimaryTenant(identity.user_id) via the service-role client (already available as sb in the route) to get the membership-authoritative primary tenant, and use identity.tenant_id only as a fast path when it matches. Add a Jest case asserting that a user whose JWT active_tenant_id differs from primary tenant still produces the primary tenant (or a documented null), matching the plan's 'never DEFAULT_TENANT_ID' invariant.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
