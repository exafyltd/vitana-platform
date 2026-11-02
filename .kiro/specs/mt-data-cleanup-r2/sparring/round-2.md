# Sparring round 2 — in_progress

Session: `d5edc866-9ce1-4b2a-be19-7ac9b40321be` · plan hash `ca0ff819c16de053f00e2bc1e97fb94d1ba222325f7f2390dd13bec56b7d0249`

## Summary

Round 2 review of the revised mt-data-cleanup plan. The planner accepted R1-F1 and addressed it in the revised plan's lane 5 section (d48 route pinned with Jest test, engine guard as backstop, no route edit). Three premises verified correctly. One new major finding: the plan's diagnosis of the d46 engine's tenant issue targets the wrong variable — the insert path uses `userContext.tenant_id` from the request input, not the `tenantId` from `getClientWithContext` at line 153. A fix targeting only line 153 would leave the actual insert path unguarded.

## Findings

### R2-F1 [major]

The plan's d46 diagnosis ('d46-anticipatory-guidance-engine.ts:153 initialises tenantId = DEV_IDENTITY.TENANT_ID; the authenticated branch never reassigns it, so an authenticated insert can carry …0001') targets the wrong variable. The `tenantId` destructured from `getClientWithContext` at line 799 is NOT used in the storage path. The actual insert at line 932 uses `userContext.tenant_id`, which comes from `request.user_context.tenant_id` or `request.window_bundle.tenant_id` (lines 802-804). A fix that only changes line 153 (or guards the `tenantId` from `getClientWithContext`) would leave the actual insert path unguarded — the stored `tenant_id` would still be whatever the caller passes in the request body. The fix must guard `userContext.tenant_id` at or before the insert site (line 895/932), not just the `tenantId` local in `getClientWithContext`.

- `exafyltd/vitana-platform:services/gateway/src/services/d46-anticipatory-guidance-engine.ts:143` — async function getClientWithContext(authToken?: string): Promise<{...}> {
  let supabase: SupabaseClient | null = null;
  let useDevIdentity = false;
  let userId = DEV_IDENTITY.USER_ID;
  let tenantId = DEV_IDENTITY.TENANT_ID;

  if (authToken) {
    supabase = createUserClient(authToken);
  } else if (isDevSandbox()) {
    ...
  }
  ...
  return { supabase, useDevIdentity, userId, tenantId };
}
- `exafyltd/vitana-platform:services/gateway/src/services/d46-anticipatory-guidance-engine.ts:799` — const { supabase, error: clientError, userId, tenantId } = await getClientWithContext(authToken);

      // Get user context from request or create default
      const userContext: UserGuidanceContext = request.user_context || {
        user_id: request.window_bundle.user_id,
        tenant_id: request.window_bundle.tenant_id,
        ...
- `exafyltd/vitana-platform:services/gateway/src/services/d46-anticipatory-guidance-engine.ts:928` — id: item.guidance_id,
        user_id: userContext.user_id,
        tenant_id: userContext.tenant_id,
        ...
      const { error } = await repo.insertAnticipatoryGuidanceRecords(supabase, records);

Suggestion: Update the plan's d46 diagnosis and fix target. The guard must be on `userContext.tenant_id` before the insert at line 895/932, not on the `tenantId` local in `getClientWithContext`. For example: after constructing `userContext` (line 802), check `userContext.tenant_id` — if empty or `…0001` (outside dev-sandbox), skip the insert and return `TENANT_UNRESOLVED`. The Jest test (d46 called on authenticated path → insert uses the caller's real tenant) should assert on the `tenant_id` in the stored record, not on the return of `getClientWithContext`.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The planner accepted R1-F1 and the revised plan properly addresses it: the d48 route is included in lane 5's scope, a Jest test (E4) pins the current 401 behavior for bearer + non-dev-sandbox, the engine guard is the backstop, and enabling the route for authenticated users is explicitly deferred to a separate plan. The route file stays in paths but is not edited. Sound approach for a data-cleanup plan.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
