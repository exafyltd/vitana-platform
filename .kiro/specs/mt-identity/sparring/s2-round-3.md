# Sparring round 3 — escalated

Session: `ee011de1-a1ce-4dd8-aaf3-d7e19e0cee14` · plan hash `01733293d15809ee167fbb31d7c27eb6bf12e4b5b0acf25928c2c894c5726865`

## Summary

The revised plan correctly addresses R2-F1 (slug→id lookup gap) and the three round-1 findings (R1-F1 autopilot-prompts migration, R1-F3 lint carve-out count, R1-F4 bot-user exclusion) in its rewritten lane-5 description and test section. Two new issues are present: (1) lane 5b replaces the hardcoded `'…0001'` fallback in `dev-auth.ts:364` with `getDefaultTenantId()`, which returns `string | null`; a null return (registry unavailable at cold start) leaves `tenantId` null and propagates it into `bootstrapRequestContext` with no specified error path; (2) the two presence-route migrations off `fetchPrimaryTenantForUser` are documented as having zero test coverage today, yet the plan names only the existing autopilot-prompts Vitest test for "the three callers," leaving the presence paths without a new or cited test.

## Findings

### R3-F1 [major]

Lane 5b replaces `dev-auth.ts:364`'s `DEV_TENANT_ID || '…0001'` with `getDefaultTenantId()`, which is declared `Promise<string | null>`. When the tenant-registry is unavailable (Supabase cold start, network failure) `getDefaultTenantId()` returns `null`, making `defaultTenantId = null` and `tenantId = tenant_id || null` when the caller omits `tenant_id`. `bootstrapRequestContext(supabase, null, role)` is then invoked with a null tenant. The existing code at line 372 treats bootstrap failure as non-fatal and continues to mint the JWT, so the silent path is: token minted with an undefined/null bootstrap tenant, returning a 200 with no error to the caller. The plan specifies no null-guard, no 503, and no last-resort fallback for this case.

- `exafyltd/vitana-platform:services/gateway/src/routes/dev-auth.ts:360` — try {
      // VTID-01050: Bootstrap request context to break the NULL-role deadlock
      const defaultTenantId = process.env.DEV_TENANT_ID || '00000000-0000-0000-0000-000000000001';
      const tenantId = tenant_id || defaultTenantId;
      ...
        const bootstrapResult = await bootstrapRequestContext(supabase, tenantId, role);
        if (!bootstrapResult.ok) {
          console.warn(`[VTID-01050] Bootstrap failed (non-fatal): ${bootstrapResult.error}`);
          // Continue anyway - the RPC might not be deployed yet
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:100` — /** The tenant new members land in (tenants.is_default); null when unresolved. */
export async function getDefaultTenantId(): Promise<string | null> {
  const flags = await loadTenantFlags();
  return flags?.defaultId ?? null;
}

Suggestion: Lane 5b must specify what happens when `getDefaultTenantId()` returns null. The safest option is to treat it as an unresolvable fallback and return early with a 503: `const registryId = await getDefaultTenantId(); if (!registryId && !process.env.DEV_TENANT_ID) return res.status(503).json({ ok: false, error: 'REGISTRY_UNAVAILABLE' });`. Do not let a null `tenantId` silently proceed into `bootstrapRequestContext`. Add a Vitest test stub: when `getDefaultTenantId()` resolves null and no `tenant_id` is in the body, `POST /dev/auth/token` returns 503 (not 200).

### R3-F2 [minor]

Lane 5c migrates `fetchPrimaryTenantForUser` in `presence.ts:55` and `presence-did-you-know.ts:63` (via `presence-repository.ts:22` and `presence-did-you-know-repository.ts:23`) to `resolvePrimaryTenant()`. Both repository files explicitly document 'zero coverage today.' The plan's Vitest section names only the 'existing `vtid-05121-autopilot-prompts-…` test' for 'the three former callers,' without adding any new test for the presence paths. After this lane ships, the presence tenant-resolution migration has no regression coverage.

- `exafyltd/vitana-platform:services/gateway/src/routes/presence-repository.ts:1` — // impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/presence.ts — zero coverage today.
- `exafyltd/vitana-platform:services/gateway/src/routes/presence-did-you-know-repository.ts:1` — // impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/presence-did-you-know.ts — zero coverage today.
- `exafyltd/vitana-platform:services/gateway/src/routes/presence.ts:54` — if (!tenantId && userId) {
        const { data: tenantRow } = await repo.fetchPrimaryTenantForUser(supabase, userId);
        tenantId = tenantRow?.tenant_id || null;
      }
- `exafyltd/vitana-platform:services/gateway/src/routes/presence-did-you-know.ts:62` — if (!tenantId && userId) {
        const { data: tenantRow } = await repo.fetchPrimaryTenantForUser(supabase, userId);
        tenantId = tenantRow?.tenant_id || null;
      }

Suggestion: Add two Vitest tests (one per route) that stub `presence-repository.fetchPrimaryTenantForUser` / `presence-did-you-know-repository.fetchPrimaryTenantForUser` and assert that with `MT_RESOLUTION_V2` on, the response tenant_id matches `resolvePrimaryTenant()`'s return value and the deprecated repo function is never called. This can be in the same `mt-identity-tenant-slug-lookup.test.ts` file the plan already adds, or a separate `mt-identity-presence-tenant.test.ts`.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The revised plan fully incorporates the fix: lane 5a adds a `bySlug: Map<string,string>` inside `loadTenantFlags()` (from the already-fetched `slug` column), exports `getTenantIdBySlug(slug): Promise<string|null>`, replaces `dev-auth.ts:491`'s `SLUG_TO_TENANT_ID[…]` with `await getTenantIdBySlug(…)` (unknown slug → 400 with live list; registry unavailable → 503), replaces `me.ts:270,408` with `(await getTenantMeta(id))?.slug ?? null`, and adds `test/mt-identity-tenant-slug-lookup.test.ts` covering both directions and the unknown-slug null case. The premise that no `bySlug`/`getTenantIdBySlug` exists at the pinned commit is confirmed; the plan's proposed solution is complete and sound.
