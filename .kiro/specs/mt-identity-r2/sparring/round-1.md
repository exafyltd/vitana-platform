# Sparring round 1 — in_progress

Session: `3703d7a6-de65-4bbb-af6f-1cd90d2e9534` · plan hash `fc292b1f9929892b00681e11f1102db340e7f885b9ae56ae38fbf7581cbecf84`

## Summary

The plan is comprehensive and well-researched. All premises I verified against the pinned code hold. The policy recount for the 4 newly found bare-policy tables is confirmed in the referenced migration files. The migration ordering, dependency structure, and governance constraints are sound. I found no blockers. Two minor findings are raised below.

## Findings

### R1-F1 [minor]

The plan says lane 5(a) removes the `me.ts:23` `SLUG_TO_TENANT_ID` map as part of the slug cleanup, listing it alongside the `TENANT_SLUGS` map at `:15` as having reads at `:270,408`. But the reads at lines 270 and 408 are actually from `TENANT_SLUGS` (id-to-slug), not `SLUG_TO_TENANT_ID` (slug-to-id). I could not find any call site for `SLUG_TO_TENANT_ID` in the portions of `me.ts` I reviewed (lines 1-50, 260-290, 395-420). If it is genuinely dead code, the removal is trivially safe but the plan's framing of it as a 'read' is misleading. If it IS used in the ~220 lines I did not read, that call site is not listed in the plan alongside the `:270,408` references. The literal lint test would catch a missed site, so this is low risk, but the implementor should confirm whether `SLUG_TO_TENANT_ID` in `me.ts` has any callers before removing it.

- `exafyltd/vitana-platform:services/gateway/src/routes/me.ts:22` — const SLUG_TO_TENANT_ID: Record<string, string> = {
  'vitana': '00000000-0000-0000-0000-000000000001',
  'maxina': '00000000-0000-0000-0000-000000000002',
  'alkalma': '00000000-0000-0000-0000-000000000003',
  'earthlings': '00000000-0000-0000-0000-000000000004',
};
- `exafyltd/vitana-platform:services/gateway/src/routes/me.ts:270` — const tenantSlug = tenantId ? (TENANT_SLUGS[tenantId] || null) : null;
- `exafyltd/vitana-platform:services/gateway/src/routes/me.ts:408` — const tenantSlug = tenantId ? (TENANT_SLUGS[tenantId] || null) : null;

Suggestion: Confirm whether `SLUG_TO_TENANT_ID` in `me.ts` has any call sites in the portions not reviewed (lines 51-259, 291-394, 421-436). If none, note it as dead code in the PR rather than listing it alongside the `:270,408` reads. The literal lint test provides a backstop regardless.

### R1-F2 [minor]

Lane 5(c) replaces the synchronous `process.env.DEV_TENANT_ID || '...0001'` fallback in `dev-auth.ts:364` with `await getDefaultTenantId()`, which calls `loadTenantFlags()` triggering a Supabase query (with 60s cache / 2.5s timeout). Similarly, lane 5(a) replaces the synchronous `SLUG_TO_TENANT_ID` map lookup at `dev-auth.ts:491` with `await getTenantIdBySlug()`. Both changes introduce a new database dependency on the dev-auth path that did not exist before. On a cold ECS task start with no cache, the first `/dev/auth/token` request will incur a Supabase round-trip that can take up to 2.5 seconds. The plan handles the failure case (503 for bootstrap roles; 400 for unknown slug) but does not mention the latency change or cold-start impact.

- `exafyltd/vitana-platform:services/gateway/src/routes/dev-auth.ts:364` — const defaultTenantId = process.env.DEV_TENANT_ID || '00000000-0000-0000-0000-000000000001';
const tenantId = tenant_id || defaultTenantId;
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:66` — const TENANT_META_CACHE_TTL_MS = 60 * 1000;
const TENANT_META_TIMEOUT_MS = 2500;
let tenantMetaCache: ...

Suggestion: Document the cold-start latency change in the PR. Since this only affects the dev-sandbox endpoint (gated by `isDevSandbox()`), the impact is low, but it is good practice to note the new database dependency so reviewers and on-call know the endpoint is no longer purely in-memory.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
