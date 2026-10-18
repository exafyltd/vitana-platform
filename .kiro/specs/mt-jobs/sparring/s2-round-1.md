# Sparring round 1 — in_progress

Session: `5871c575-a41b-49a5-848b-4b5d04377f22` · plan hash `f3d5470b3c42f70cf855ec9c163cd64d5ebcffa226c6c84379c2a3ba2fb2d53a`

## Summary

Seven premises verified against pinned code; one cannot be confirmed. Two major findings: (1) lane 1 directs the implementer to remove TENANT_ID from a "target input" field that does not exist in the EventBridge schedule JSON — the tenant is actually baked into the Lambda's --environment variables and inline handler code; (2) the key premise that morning-brief-scheduler.ts:132 is already tenant-safe (used to exclude morning brief from scope) references a file the search could not locate. Three minor findings: mischaracterised dispatch site at groups-events-tools.ts:360, multiplication of OASIS events in the community-scan tenant loop, and ambiguous per-tenant flag resolution for the heartbeat startup path.

## Findings

### R1-F1 [major]

Lane 1 says 'Removes the single-tenant DEFAULT_TENANT_ID default from the four setup-eventbridge-*.sh target inputs', but the EventBridge schedule target for setup-eventbridge-whats-new.sh contains no Input field at all. TENANT_ID lives in two other artifacts: (a) the shell variable at line 42 passed into the Lambda --environment Variables at lines 204/218; (b) the inline Lambda handler at line 158 which sends JSON.stringify({ tenant_id: process.env.TENANT_ID }) as the HTTP body. An implementer following the plan literally searches the schedule Target JSON (lines 270-276, which has only Arn/RoleArn/RetryPolicy) for a 'target input' to remove, finds nothing, and leaves the Lambda env var and handler code untouched. The currently deployed Lambda continues to POST { tenant_id: '2e7528b8-…' } to the gateway on every tick.

- `exafyltd/vitana-platform:scripts/aws/setup-eventbridge-whats-new.sh:40` — TENANT_ID="${DEFAULT_TENANT_ID:-2e7528b8-472a-4356-88da-0280d4639cce}"
- `exafyltd/vitana-platform:scripts/aws/setup-eventbridge-whats-new.sh:153` — exports.handler = async () => {
  const url = new URL(
    (process.env.GATEWAY_URL || 'https://gateway.vitanaland.com') +
    '/api/v1/scheduled-notifications/whats-new'
  );
  const payload = JSON.stringify({ tenant_id: process.env.TENANT_ID });
- `exafyltd/vitana-platform:scripts/aws/setup-eventbridge-whats-new.sh:200` — --environment "Variables={GATEWAY_URL=$GATEWAY_URL,TENANT_ID=$TENANT_ID,GATEWAY_INTERNAL_TOKEN_SECRET_ID=$INTERNAL_TOKEN_SECRET_ID}"
- `exafyltd/vitana-platform:scripts/aws/setup-eventbridge-whats-new.sh:270` — TARGET=$(cat <<JSON
{
  "Arn": "${LAMBDA_ARN}",
  "RoleArn": "${SCHEDULER_ROLE_ARN}",
  "RetryPolicy": { "MaximumRetryAttempts": 0 }
}
JSON
)

Suggestion: Reword and expand lane 1: (a) remove TENANT_ID from the --environment Variables block in each of the four setup-eventbridge-*.sh scripts; (b) update the inline Lambda handler JS in each script to send an empty body (JSON.stringify({})) instead of { tenant_id: process.env.TENANT_ID }; (c) re-run the updated scripts against the AWS estate so both the Lambda configuration and code are replaced for each function. The gateway's own DEFAULT_TENANT_ID env var already provides the flag-OFF fallback via getTenantId(req), so no gateway code change is needed for that path.

### R1-F2 [major]

Problem 4's premise — 'Morning brief (morning-brief-scheduler.ts:132) already fetches each user's tenant_id from app_users … the candidate query is the only thing that is not tenant-loop-scoped' — references morning-brief-scheduler.ts, a file that cannot be located in the repository. A search returned only morning-brief-scheduler-repository.ts in the guide service. If the scheduler file does not exist at that path, the premise that morning brief is already tenant-safe is unverified, and the plan's decision to exclude it from all four lanes lacks an evidence base. The /morning-briefing route in scheduled-notifications.ts does call getTenantId(req) at line 478 and would be covered by lane 2, but whether a separate scheduler layer also exists and is already correct is unknown.

- `exafyltd/vitana-platform:services/gateway/src/routes/scheduled-notifications.ts:477` — router.post('/morning-briefing', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });
- `exafyltd/vitana-platform:services/gateway/src/services/guide/morning-brief-scheduler-repository.ts:38` — export async function fetchUsersForMorningBrief(supabase: SupabaseClient, userIds: string[]) {
  return supabase
    .from('app_users')
    .select('user_id, tenant_id, display_name')
    .in('user_id', userIds);
}

Suggestion: Before implementation, read services/gateway/src/services/guide/morning-brief-scheduler.ts (or the actual path) and confirm line 132 does what the plan claims. If the file does not exist or the candidate-user query is not already tenant-scoped, add it to lane 2's scope alongside the other getTenantId-driven routes.

### R1-F3 [minor]

The plan characterises all seven automation-event dispatch sites as 'pin process.env.DEFAULT_TENANT_ID as the actor tenant'. groups-events-tools.ts:360 already evaluates id.tenant_id || process.env.DEFAULT_TENANT_ID — the user's session-resolved tenant is tried first; DEFAULT_TENANT_ID is only the fallback. This site has a different shape from the other six.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/groups-events-tools.ts:357` — try {
  const tenantId = id.tenant_id || process.env.DEFAULT_TENANT_ID;
  if (tenantId) {
    const { dispatchEvent } = await import('../automation-executor');
    dispatchEvent(tenantId, 'community.member.joined', {
      group_id: group.id,
      user_id: id.user_id,
    }).catch(() => {});
  }
}

Suggestion: Annotate this site separately in lane 3. The fix (use resolveActorTenant) is the same but the risk is lower since the common path is already correct. Add a dedicated Vitest assertion confirming id.tenant_id-present cases are not regressed by the change.

### R1-F4 [minor]

Lane 4 wraps runCommunityScan in a per-tenant loop, but the /community-scan route handler emits an OASIS event community_autopilot.scan.completed after each call (autopilot-recommendations.ts:2299-2309). With N active tenants, N OASIS events fire per hourly tick instead of one. The plan does not address aggregation or suppression.

- `exafyltd/vitana-platform:services/gateway/src/routes/autopilot-recommendations.ts:2299` — await emitOasisEvent({
  vtid: 'SYSTEM',
  type: 'community_autopilot.scan.completed' as any,
  source: 'community-autopilot',
  status: 'info',
  message: `Community scan: ${summary.members_scanned} members, ${summary.rows_inserted} suggestions${summary.dry_run ? ' (dry run)' : ''}`,
  payload: {
    enabled: summary.enabled, dry_run: summary.dry_run, members_considered: summary.members_considered,
    members_due: summary.members_due, members_scanned: summary.members_scanned, rows_inserted: summary.rows_inserted,
  },
}).catch(() => {});

Suggestion: Either emit one aggregated OASIS event after the full per-tenant loop completes (collecting each tenant's ScanRunSummary into the payload), or move the OASIS emit inside runCommunityScan so it is tenant-tagged and the route handler no longer emits. Document the decision in lane 4.

### R1-F5 [minor]

The plan proposes isJobsTenantLoopEnabled(env, settings) where settings implies per-tenant tenant_settings. The heartbeat setInterval is registered once at server startup (index.ts:1849). If the flag check reads one tenant's settings at init time, it cannot correctly represent a per-tenant gate. The plan is silent on whether the flag is evaluated at init time (wrong) or inside each tick against each active tenant's settings (correct, but then the function signature implies a different calling pattern than described).

- `exafyltd/vitana-platform:services/gateway/src/index.ts:1843` — const heartbeatEnabled = process.env.AUTOPILOT_HEARTBEAT_ENABLED === 'true';
const heartbeatTenantId = process.env.DEFAULT_TENANT_ID;
if (heartbeatEnabled && heartbeatTenantId) {
  const { runHeartbeatCycle } = require('./services/automation-executor');
  const HEARTBEAT_INTERVAL_MS = parseInt(process.env.AUTOPILOT_HEARTBEAT_INTERVAL_MS || '60000', 10);
  let heartbeatRunning = false;
  setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const result = await runHeartbeatCycle(heartbeatTenantId);

Suggestion: Clarify in the lane 2 spec that the per-tenant feature-flag check (jobs_tenant_loop) is evaluated inside each interval tick, not at init time. isJobsTenantLoopEnabled should be called inside the setInterval callback with per-tenant settings fetched on that tick. Add a Vitest case: flag toggled off mid-flight stops the tenant loop on the next tick without a server restart.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
