# Sparring round 1 — in_progress

Session: `76c3c99c-cf9a-4e72-aec4-4995d7755ae7` · plan hash `5a4f6c3d86cb45bfe582155e19427813b3f6afa8d61743498a688b775f4afddd`

## Summary

The plan's core diagnosis is accurate: the heartbeat loop, scheduled-notification routes, community scan, and six automation-event dispatch sites all resolve a single tenant from DEFAULT_TENANT_ID, and the memory-backfill loop reads tenant IDs from env. Most premises verified against code. Substantive issues: (1) the plan mis-states a dependency — resolvePrimaryTenant/TenantContext already exist (VTID-05149, tenant-context.ts), so lane 3's "falls back to primary user_tenants row read directly" contradicts reality; (2) the per-tenant timezone/flags premise is unverified — tenant-context-repository.ts reads only tenants.slug/is_default/is_platform, and no evidence of tenant_settings.timezone or tenant_settings.feature_flags.mt.* exists at the pinned commit; (3) community-scan aggregation changes the OASIS payload shape with downstream consumers unaccounted; (4) community-scan tenant-scoped member query has no stated filter strategy for multi-tenant members; (5) the heartbeat startup gate (DEFAULT_TENANT_ID truthy at index.ts:1845) is unaddressed for the flag-on/no-default path. Also notable (not a formal finding due to no read_file evidence for the scripts): lane 1 cites EventBridge shell scripts (setup-eventbridge-*.sh) with line numbers that were never read at the pinned commit — those scripts must be located and read before relying on Problem 7's line numbers.

## Findings

### R1-F1 [major]

The plan lists mt-identity (WS1) resolvePrimaryTenant() + TenantContext as a pending 'Depends on' dependency, but these already exist and are implemented in tenant-context.ts (VTID-05149), including resolvePrimaryTenant and getTenantMeta/getDefaultTenantId. Lane 3's stated fallback 'falls back to the primary user_tenants row read directly' is based on a false premise that could cause the implementer to re-read user_tenants instead of reusing the existing resolver, and the 'Depends on' section is factually wrong.

- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:43` — export async function resolvePrimaryTenant(userId, opts) { const supabase = getSupabase(); ... const { data, error } = await repo.fetchPrimaryMembership(supabase, userId, opts?.signal); ... return { status: 'found', tenantId: row.tenant_id, ... } }

Suggestion: Correct the 'Depends on' section: mt-identity's resolvePrimaryTenant/TenantContext is already shipped. Lane 3 should import resolvePrimaryTenant from services/tenancy/tenant-context.ts rather than describing a fallback re-read of user_tenants. Remove the false dependency and state the actual seam reuse.

### R1-F2 [major]

The plan asserts per-tenant timezone (`tenant_settings.timezone`) and `tenant_settings.feature_flags.mt.jobs_tenant_loop` already exist as read-only M0 data. But the only tenant-settings repository read in the repo (tenant-context-repository.ts) selects only `tenants.slug/is_default/is_platform` — there is no evidence of a `tenant_settings` table with a `timezone` column or a `feature_flags` jsonb, nor a read path for it. job-tenant-loop.ts's `tenantTimezone(sb, tenantId)` and `isJobsTenantLoopEnabled` reading `tenant_settings.feature_flags.mt.*` target a schema that is not proven to exist at the pinned commit.

- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context-repository.ts:29` — export async function fetchTenantFlags(sb, signal) { let query = sb.from('tenants').select('tenant_id, slug, is_default, is_platform'); ... }

Suggestion: Cite and read the actual migrations 20261014000100 / 20261014000400 (or the tenant_settings table definition and any existing feature_flags reads) to prove `tenant_settings.timezone` and `tenant_settings.feature_flags.mt.jobs_tenant_loop` exist. If they are separate from the tenants flags read, add the read path (repository) to job-tenant-loop.ts explicitly. Do not assume the schema; verify before implementation.

### R1-F3 [major]

Community scan is flagged for tenant-looping, but runCommunityScan has NO tenant parameter and reads members platform-wide via `user_tenants WHERE is_primary=true` (limit 5000). The fix adds a tenantId and loops per tenant, but the plan gives no filter strategy for a tenant-scoped member query. Members can hold multiple tenants; a `user_tenants.eq(tenant_id, tenantId)` filter on the primary-row query silently misses members whose primary tenant is elsewhere but who belong to the scanned tenant's community, and can double-scan. The plan never specifies how to select 'members of tenant X' correctly.

- `exafyltd/vitana-platform:services/gateway/src/services/community-autopilot/scan-runner.ts:265` — const members = await rows(sb.from('user_tenants').select('user_id').eq('is_primary', true).limit(5000)); memberIds = [...new Set(members.map((m) => m.user_id))];

Suggestion: Specify the tenant-scoped member query explicitly (e.g., filter user_tenants by tenant_id rather than is_primary, or join on the tenant's membership relation), and add a test asserting a member with primary tenant A but membership in tenant B is (or is not) scanned under tenant B, matching the intended product semantics.

### R1-F4 [major]

The plan changes the community-scan OASIS event from one `community_autopilot.scan.completed` per call (scalar payload fields) to one aggregated event whose payload collects N tenants' ScanRunSummary objects. This is a breaking change to the event payload schema for any downstream consumer reading `payload.members_scanned`, `payload.rows_inserted`, etc. as scalars. The plan records the 'decision' but does not identify downstream consumers or preserve a backward-compatible scalar summary.

- `exafyltd/vitana-platform:services/gateway/src/routes/autopilot-recommendations.ts:2299` — await emitOasisEvent({ type: 'community_autopilot.scan.completed', payload: { enabled: summary.enabled, dry_run: summary.dry_run, members_considered: summary.members_considered, members_due: summary.members_due, members_scanned: summary.members_scanned, rows_inserted: summary.rows_inserted } })

Suggestion: Either keep the per-call scalar summary fields at the top level of the aggregated payload (e.g., totals) alongside a per-tenant array, or identify and notify all downstream consumers of the shape change and add a compatibility path. Add a test asserting the aggregated event still carries backward-compatible totals.

### R1-F6 [minor]

The plan's per-tick flag evaluation applies only to the tenant list, but the heartbeat interval registration is gated at startup on `DEFAULT_TENANT_ID` being truthy (index.ts:1845 `if (heartbeatEnabled && heartbeatTenantId)`). Under flag-on with no DEFAULT_TENANT_ID set (the eventual multi-tenant world where DEFAULT_TENANT_ID is removed in M2), the heartbeat interval is never registered, so the fan-out cannot run. The plan documents the M2 cleanup as out of scope but does not reconcile the startup gate for the flag-on path while DEFAULT_TENANT_ID is present-but-irrelevant.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:1843` — const heartbeatEnabled = process.env.AUTOPILOT_HEARTBEAT_ENABLED === 'true'; const heartbeatTenantId = process.env.DEFAULT_TENANT_ID; if (heartbeatEnabled && heartbeatTenantId) {

Suggestion: Clarify that under flag-on the heartbeat registration gate must be driven by the flag (and/or heartbeat-enabled env) rather than DEFAULT_TENANT_ID truthiness, or explicitly scope this to M2 and document the transitional behavior. Ensure the flag-on test covers the no-DEFAULT_TENANT_ID case.

### R1-F7 [minor]

The plan declares the morning-brief scheduler layer (guide/morning-brief-scheduler.ts) out of scope as 'already tenant-correct' (verified: per-user u.tenant_id at :140/:152), while keeping the `/morning-briefing` route in scope via getTenantId. This means morning briefs dispatch via two mechanisms: the scheduler (walks all users once with per-user tenant) and the route (getTenantId default, now fanning out per active tenant). In a multi-tenant world these can double-dispatch morning briefs for the same user. The plan does not reconcile the two dispatch paths or state which is authoritative.

- `exafyltd/vitana-platform:services/gateway/src/services/guide/morning-brief-scheduler.ts:140` — tenant_id: u.tenant_id ... const result = await notifyUser(u.user_id, u.tenant_id, 'morning_briefing_ready', brief, supabase)

Suggestion: State which morning-brief dispatch path is live (scheduler vs. route) and add a reconciliation/guard against double-dispatch, or document why the idempotency check (findRecentlyNotified at scheduled-notifications.ts:497) already prevents the route duplicate and confirm the scheduler has equivalent protection.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
