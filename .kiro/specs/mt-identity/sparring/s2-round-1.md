# Sparring round 1 — in_progress

Session: `2cc96038-ed5f-40e6-b7df-b6595046f5a7` · plan hash `83e9261f21f26202e3d8ee9858b4e82737463cbfa9a52ecc7887b047e210c489`

## Summary

Five premises verified against the pinned commit. One blocker (no access-control spec for the new mismatch-log table), one major (DEV_IDENTITY at orb-memory-bridge.ts:66 is mischaracterised as a four-entry slug map — the implementation approach for this site is undefined), and three minors (auth-supabase-jwt-repository.ts forward-reference scope narrower than stated; initPlan claim for is_member(tenant_id) is wrong; dual-write trigger conflict handling unspecified). All findings are directly cited from read_file results.

## Findings

### R1-F1 [blocker]

Lane 3 creates a tenant_claim_mismatch_log table that records JWT shadow-claim mismatches but the plan specifies no RLS policy and no REVOKE from PUBLIC/anon/authenticated for it. If the migration creates the table without ALTER TABLE … ENABLE ROW LEVEL SECURITY (or with RLS enabled but no policy, which still defaults to DENY), the authenticated PostgREST role can read every other user's shadow-claim decision rows. The plan's N3 lint only counts bare current_tenant_id() policies on existing tables — it does not catch a net-new table with missing access control.

- `exafyltd/vitana-platform:supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql:1` — -- VTID-05149 (multi-tenant M0, lane A) M3: public.ci_tenant_isolation_health().
-- Counts and table names only, never row content.
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:1` — -- VTID-05149 (multi-tenant M0, lane A): the one place the gateway resolves a user's tenant

Suggestion: Add an explicit service-role-only access block to 20261101032100_tenant_claim_mismatch_log.sql: REVOKE ALL ON public.tenant_claim_mismatch_log FROM PUBLIC, anon, authenticated; GRANT ALL ON public.tenant_claim_mismatch_log TO service_role; ALTER TABLE public.tenant_claim_mismatch_log ENABLE ROW LEVEL SECURITY; (no POLICY, so RLS denies all non-service-role access). Name the security posture in the plan body so the reviewer and the N3 lint both see it.

### R1-F2 [major]

The plan states the four slug-map / fake-id sites to remove are 'me.ts:15+:23, dev-auth.ts:26, orb-memory-bridge.ts:66 (each a four-entry …0001–…0004 map)'. This mischaracterises orb-memory-bridge.ts:66. The actual code there is DEV_IDENTITY — a five-field exported struct with a single hardcoded vitana-tenant reference (TENANT_ID: '00000000-0000-0000-0000-000000000001', TENANT_SLUG: 'vitana'). It is not a map at all and has no 0002/0003/0004 entries. The plan's cleanup prescription ('resolution goes through TenantContext') does not translate directly to a dev-sandbox identity constant that has no user session to resolve against. Without a concrete replacement strategy, the implementer will either leave the hardcoded …0001 in place, or break sandbox testing by applying the slug-map iteration pattern to a struct.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-memory-bridge.ts:66` — export const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001',
  TENANT_SLUG: 'vitana',
  ACTIVE_ROLE: 'developer',
  DISPLAY_NAME: 'Dev User (ORB Sandbox)'
};
- `exafyltd/vitana-platform:services/gateway/src/routes/me.ts:15` — const TENANT_SLUGS: Record<string, string> = {
  '00000000-0000-0000-0000-000000000001': 'vitana',
  '00000000-0000-0000-0000-000000000002': 'maxina',
  '00000000-0000-0000-0000-000000000003': 'alkalma',
  '00000000-0000-0000-0000-000000000004': 'earthlings',
};
- `exafyltd/vitana-platform:services/gateway/src/routes/dev-auth.ts:26` — const SLUG_TO_TENANT_ID: Record<string, string> = {
  'vitana': '00000000-0000-0000-0000-000000000001',
  'maxina': '00000000-0000-0000-0000-000000000002',
  'alkalma': '00000000-0000-0000-0000-000000000003',
  'earthlings': '00000000-0000-0000-0000-000000000004',
};

Suggestion: Treat orb-memory-bridge.ts:66 as a distinct case in lane 5. DEV_IDENTITY.TENANT_ID/TENANT_SLUG should either (a) be driven by a DEV_TENANT_SLUG env var that defaults to 'vitana' (DB-registry-backed at runtime in the sandbox) or (b) remain as a named constant but with an explicit comment and an exclusion in the fake-id lint, since the dev user …0099 is pinned to a real tenant by design. The plan body should state which of these options is chosen and add a test that the …0001 literal does not appear outside of DEV_IDENTITY and the two vitana-v1 legitimate slug-map sites.

### R1-F3 [minor]

The plan states 'tenantDb/TENANT_TABLES/isHealthTable/healthDb do not exist (only a forward-reference comment at services/gateway/src/middleware/auth-supabase-jwt-repository.ts:21)'. Reading the full 45-line file, line 21 contains only a passing mention of 'the tenantDb slice' as a future lane concept. TENANT_TABLES, isHealthTable, and healthDb are not mentioned anywhere in the file. Three of the four CODE-lane components have zero textual anchoring in the existing codebase. The plan then asserts 'this spec OWNS the canonical isHealthTable() (O1), referenced by other specs'. Other specs that cross-reference O1 are depending on a definition that has no prior art in the codebase at all, increasing the risk of disagreement at integration time.

- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt-repository.ts:17` — `fetchPrimaryTenantForUser` was the primary-tenant query of requireTenant
 * and requireAuthWithTenant. VTID-05149 moved both to the shared resolver
 * (services/tenancy/tenant-context.ts); it stays only for
 * routes/autopilot-prompts.ts, which moves with the other is_primary readers
 * in the tenantDb slice.

Suggestion: Add a CODE-lane interface stub (or a dedicated section in the plan) that specifies the exact TypeScript signatures of TENANT_TABLES (type), isHealthTable(tableName: string): boolean, tenantDb(ctx: TenantContext), and healthDb(userId: string) before implementation begins. This is the O1 contract that downstream specs depend on; spelling it out in the plan rather than leaving it implicit protects against integration-time drift.

### R1-F4 [minor]

The plan claims 'policies call them through (select …) so Postgres evaluates them once per statement (initPlan), not per row — keeping cost bounded on user_notifications/chat_messages'. This is correct for (select tenant_id_for_policies()) because that subquery has no reference to any table column and Postgres can hoist it as an initPlan. It is NOT correct for (select is_member(tenant_id)) in a tenant-shared policy USING clause, because tenant_id there refers to the outer table's column — the subquery is correlated and cannot be an initPlan. Postgres will call is_member() once per row on every tenant-shared table scan regardless of the (select …) wrapper. The plan explicitly groups the two together and names user_notifications/chat_messages as cost-bounded by this optimisation, but those hot tables use user-private policies (tenant_id_for_policies), not is_member — so the optimisation does apply there. The risk is that the plan's cost analysis is not reproducible for the tenant-shared tables.

- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:43` — export async function resolvePrimaryTenant(
  userId: string,
  opts?: { signal?: AbortSignal }
): Promise<PrimaryTenantResult> {
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:53` — `is_member()` and this fallback share one lookup, and policies call them through `(select current_tenant_id())` so Postgres evaluates them once per statement (initPlan), not per row

Suggestion: Separate the cost claim into two sentences: (1) (select tenant_id_for_policies()) is an initPlan — one indexed lookup per statement on the hot user-private tables. (2) (select is_member(tenant_id)) is per-row on tenant-shared tables (correlated on the column); acceptable because is_member() is a STABLE SECURITY DEFINER function over a unique index, so each call is a single index probe. Add a pgTAP or EXPLAIN-based check in the test plan that confirms the per-row cost for the largest tenant-shared table (live_rooms) is within an agreed bound.

### R1-F5 [minor]

Lane 2 converts memberships into a view over user_tenants and adds 'a dual-write trigger for legacy writers'. The plan states the backfill uses ON CONFLICT DO NOTHING and the four AFTER INSERT triggers on user_tenants carry a per-transaction suppression guard during the backfill. However, the plan does not specify whether the dual-write trigger itself (the ongoing path, not the one-off backfill) also uses INSERT … ON CONFLICT DO NOTHING or equivalent idempotency. If legacy code re-upserts an existing memberships row after cutover (e.g. an idempotent signup path that always inserts), the trigger will issue a plain INSERT into user_tenants, which — if the row already exists and there is no conflict guard — will either error out or, if the trigger uses ON CONFLICT DO UPDATE, fire the four AFTER INSERT triggers again. The VTID-03990 incident shape (duplicate welcome DMs triggered by a re-insert) is documented in the program plan §3/S-E as the canonical risk. The plan mitigates it only for the migration backfill, not for the trigger's steady-state path.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:41` — the RPC inserts with `ON CONFLICT (tenant_id, user_id) DO NOTHING` (unique index `user_tenants_tenant_id_user_id_key` exists) and `is_primary = true` only when the user has no primary membership yet; (3) pgTAP + contract test: self-enrolling an already-known member creates zero `chat_messages`, zero founding seats, zero autopilot rows, zero live rooms.
- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt-repository.ts:35` — export async function fetchPrimaryTenantForUser(sb: SupabaseClient, userId: string, signal: AbortSignal) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).abortSignal(signal).single();
}

Suggestion: Explicitly state in the lane 2 migration spec that the dual-write trigger body uses INSERT INTO user_tenants … ON CONFLICT (tenant_id, user_id) DO NOTHING, and add a pgTAP test that re-inserting the same memberships row a second time creates zero additional chat_messages, founding seats, autopilot rows, and live rooms (the same contract test already called for in the program plan §3/S-E, applied here to the ongoing trigger path).

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
