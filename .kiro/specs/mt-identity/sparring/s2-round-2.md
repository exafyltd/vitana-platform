# Sparring round 2 — in_progress

Session: `ee011de1-a1ce-4dd8-aaf3-d7e19e0cee14` · plan hash `43658ee32db00aa824f8777fad076586e803798b55b9620ebefc7ea08cb7e7ef`

## Summary

All three R1 findings were accepted and are substantively addressed in the revised plan. One new major finding: the plan removes `SLUG_TO_TENANT_ID` from `me.ts` and `dev-auth.ts` and says resolution goes "through the DB registry + TenantContext", but `tenant-context.ts` exports no slug→id lookup function and `loadTenantFlags()` builds only a `byId` map. `dev-auth.ts:491` has a hard runtime dependency on slug→id resolution that has no replacement in the current API. A `getTenantIdBySlug()` function must be explicitly added to the plan scope.

## Findings

### R2-F1 [major]

The plan removes `SLUG_TO_TENANT_ID` from `me.ts:23` and `dev-auth.ts:26` and states resolution will go 'through the DB registry + TenantContext', but `tenant-context.ts` has no slug→id lookup function. `loadTenantFlags()` builds only a `byId: Map<string, TenantMeta>` (tenant_id→meta) and a `defaultId`; there is no `bySlug` map and no exported `getTenantIdBySlug()`. `dev-auth.ts:491` calls `SLUG_TO_TENANT_ID[tenant_slug.toLowerCase()]` to resolve a tenant UUID from a caller-supplied slug and returns a hard 400 if it is absent — after the map is deleted this call site has no replacement and will return `undefined`, causing every `/dev/auth/role` request with a valid slug to fail with an `INVALID_TENANT_SLUG` 400 at runtime.

- `exafyltd/vitana-platform:services/gateway/src/routes/dev-auth.ts:26` — const SLUG_TO_TENANT_ID: Record<string, string> = {
  'vitana': '00000000-0000-0000-0000-000000000001',
  'maxina': '00000000-0000-0000-0000-000000000002',
  'alkalma': '00000000-0000-0000-0000-000000000003',
  'earthlings': '00000000-0000-0000-0000-000000000004',
};
- `exafyltd/vitana-platform:services/gateway/src/routes/dev-auth.ts:491` — const tenantId = SLUG_TO_TENANT_ID[tenant_slug.toLowerCase()];
    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_TENANT_SLUG',
        message: `tenant_slug must be one of: ${Object.keys(SLUG_TO_TENANT_ID).join(', ')}`,
      });
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context-repository.ts:29` — /** VTID-05149: every tenant's identity flags (2 rows today); cached by the caller. */
export async function fetchTenantFlags(sb: SupabaseClient, signal?: AbortSignal) {
  let query = sb.from('tenants').select('tenant_id, slug, is_default, is_platform');
  if (signal) query = query.abortSignal(signal);
  return query;
}
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:70` — async function loadTenantFlags(): Promise<{ byId: Map<string, TenantMeta>; defaultId: string | null } | null> {
    if (tenantMetaCache && tenantMetaCache.expiresAt > Date.now()) return tenantMetaCache;
    ...
    const byId = new Map<string, TenantMeta>();
    let defaultId: string | null = null;
    for (const t of data ...) {
      byId.set(t.tenant_id, { slug: t.slug ?? '', isPlatform: t.is_platform === true, isDefault: t.is_default === true });
      if (t.is_default === true) defaultId = t.tenant_id;
    }
    tenantMetaCache = { byId, defaultId, expiresAt: ... };
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:94` — /** Slug and flags of one tenant; null when unknown or the lookup failed. */
export async function getTenantMeta(tenantId: string): Promise<TenantMeta | null> {
  const flags = await loadTenantFlags();
  return flags?.byId.get(tenantId) ?? null;
}

/** The tenant new members land in (tenants.is_default); null when unresolved. */
export async function getDefaultTenantId(): Promise<string | null> {
  const flags = await loadTenantFlags();
  return flags?.defaultId ?? null;
}

Suggestion: Lane 5a must explicitly add `getTenantIdBySlug(slug: string): Promise<string | null>` to `tenant-context.ts`, backed by a `bySlug: Map<string, string>` built inside `loadTenantFlags()` from the already-fetched `slug` column. Replace `SLUG_TO_TENANT_ID[tenant_slug.toLowerCase()]` at `dev-auth.ts:491` with `await getTenantIdBySlug(tenant_slug.toLowerCase())` and handle the null (DB-unavailable) case — either fall through to a 503 or keep the 400 with a dynamic slug list from `Array.from(bySlug.keys())`. The id→slug direction (`TENANT_SLUGS` at `me.ts:270`/`:408`) can be replaced directly with `(await getTenantMeta(tenantId))?.slug ?? null`, which is already supported. Add a Vitest test that stubs `loadTenantFlags` and asserts both `getTenantMeta(id)` and `getTenantIdBySlug(slug)` round-trip correctly, and that `getTenantIdBySlug` returns null for an unknown slug.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The revised plan explicitly adds all three `fetchPrimaryTenantForUser` call sites (autopilot-prompts.ts:109, presence.ts:55, presence-did-you-know.ts:63) and both their repository files (presence-repository.ts:22, presence-did-you-know-repository.ts:23) to lane 5c, migrates them to `resolvePrimaryTenant()` behind MT_RESOLUTION_V2, marks the three repo fns @deprecated, and rewrites the VTID-05149 comment at auth-supabase-jwt-repository.ts:17. All call sites are confirmed in the pinned code. Rationale is sound.
- R1-F3: acknowledged — The revised lint is restructured into two well-defined parts: (1) a zero-tolerance check that me.ts, dev-auth.ts, and orb-memory-bridge.ts contain no `…0001`–`…0004` literals (no carve-out), and (2) a ratchet bounding `…0001` literals outside the single exempt site lib/vitana-bot.ts. orb-memory-bridge.ts is removed from the carve-out. The ~30 other literals (d28–d51 constants, admin-tenants-repository.ts:57 duplicate, etc.) are explicitly named as WS2 cleanup under the ratchet. Rationale is sound.
- R1-F4: acknowledged — The revised plan excludes the bot user (lib/vitana-bot.ts:9, `…0001`) and every `service_bot_accounts` user from both the backfill query and the drift report member counts, and adds a pgTAP check that inserting a memberships row for the bot yields zero chat_messages. The collision between bot USER_ID and vitana TENANT_ID is noted in Risks. Rationale is sound.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
