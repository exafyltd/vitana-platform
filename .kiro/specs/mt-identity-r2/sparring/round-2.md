# Sparring round 2 — converged

Session: `3703d7a6-de65-4bbb-af6f-1cd90d2e9534` · plan hash `9e7bf2ae006ac83007eaab3edf718f08ae87cb30db4c3316e96c183d0cb04cc1`

## Summary

Round 2 review of mt-identity revised plan. Both R1-F1 and R1-F2 were accepted and addressed in the revision. I verified key premises against the pinned code: the gateway test runner (Jest), `MT_RESOLUTION_V2` location, `fetchPrimaryTenantForUser` call sites, presence repository line numbers, dev-auth slug map and fallback, require-tenant-admin dual role check, and the newly-found bare-policy tables. All verified premises hold. I found one new minor issue related to the presence route refactoring.

## Findings

### R2-F1 [minor]

Lane 5(d) lists three `fetchPrimaryTenantForUser` callers to migrate to `resolvePrimaryTenant()`, but the `presence.ts:55` and `presence-did-you-know.ts:63` call sites use a different `fetchPrimaryTenantForUser` signature than `autopilot-prompts.ts:109`. The presence repositories (`presence-repository.ts:22`, `presence-did-you-know-repository.ts:23`) take `(sb, userId)` with no `AbortSignal`, while `auth-supabase-jwt-repository.ts:35` takes `(sb, userId, signal)`. This is not a bug — `resolvePrimaryTenant()` at `tenant-context.ts:43` accepts an optional `signal` so both call shapes can migrate — but the plan does not mention that the presence callers also lack the `AbortSignal` timeout protection that the autopilot-prompts caller has (via `TENANT_LOOKUP_TIMEOUT_MS` at `:107`). Without a timeout, a slow Supabase on the presence path hangs the request indefinitely. The migration to `resolvePrimaryTenant()` will actually fix this (it uses `TENANT_META_TIMEOUT_MS` internally), but the plan should note this as a latent improvement so the reviewer knows it is intentional.

- `exafyltd/vitana-platform:services/gateway/src/routes/presence-repository.ts:22` — export async function fetchPrimaryTenantForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).limit(1).maybeSingle();
}
- `exafyltd/vitana-platform:services/gateway/src/routes/presence.ts:54` — if (!tenantId && userId) {
        const { data: tenantRow } = await repo.fetchPrimaryTenantForUser(supabase, userId);
        tenantId = tenantRow?.tenant_id || null;
- `exafyltd/vitana-platform:services/gateway/src/routes/autopilot-prompts.ts:106` — const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TENANT_LOOKUP_TIMEOUT_MS);
    try {
      const { data } = await fetchPrimaryTenantForUser(admin, userId, controller.signal);
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:43` — export async function resolvePrimaryTenant(
  userId: string,
  opts?: { signal?: AbortSignal }
): Promise<PrimaryTenantResult> {

Suggestion: Note in the PR that the presence migration to `resolvePrimaryTenant()` also gains a timeout (via `TENANT_META_TIMEOUT_MS`) that the current raw-Supabase calls lack. This is a latent improvement, not a regression, but reviewers should know the behaviour change.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed. The revised plan now correctly identifies `SLUG_TO_TENANT_ID` in `me.ts:23` as dead code with no reader, separate from the `TENANT_SLUGS` reads at `:270,408`.
- R1-F2: acknowledged — Accepted and addressed. The revised plan's lane 5(c) now explicitly documents the new registry read on the dev-sandbox path, the cold-start latency (up to 2.5s `TENANT_META_TIMEOUT_MS`), and requires the lane PR to state the new DB dependency.
