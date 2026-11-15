# Sparring round 1 — in_progress

Session: `05c2a910-4ba9-4754-89b8-a22891c4d8a1` · plan hash `173fab4b0fb960be7c860fb8ae4fa019ddb7004ddf387fa2a86268be816c919a`

## Summary

Verified 6 premises. Two material gaps found: (1) the rolling-window background scheduler cannot use the existing `live_room_create_session` RPC path because that path requires a user JWT, and (2) the plan references an "existing scheduler" in the gateway that does not exist as a shared framework — each background worker is an independently registered setInterval. One minor gap on OASIS event coverage for series lifecycle operations.

## Findings

### R1-F1 [major]

The rolling-window materialisation job cannot create sessions 'through the existing live_room_create_session path' because that RPC requires a user JWT for host authorisation, and a background scheduler has no user context.

- `exafyltd/vitana-platform:services/gateway/src/services/room-session-manager.ts:78` — async function callRpc(token: string, functionName: string, params: Record<string, unknown>): Promise<RpcResult> { ... 'Authorization': `Bearer ${token}`, ...
- `exafyltd/vitana-platform:services/gateway/src/services/room-session-manager.ts:146` — 1. Call live_room_create_session RPC (validates host, creates session) ... async createSession(roomId: string, payload: CreateSessionPayload, token: string): Promise<SessionCreateResult> { ... const result = await callRpc(token, 'live_room_create_session', { p_room_id: roomId,

Suggestion: The plan must specify that the rolling-window worker inserts directly into `live_room_sessions` via service_role (bypassing the RPC's auth.uid() host check), or call the RPC under a service_role header that skips the host guard. Either way, specify how host-ownership validation is preserved at creation time (e.g. the series row already records host_user_id, so the worker trusts it). Document the alternative path and ensure the idempotency_key index still prevents duplicates.

### R1-F2 [major]

The plan says the rolling-window materialisation uses the 'services/gateway existing scheduler, one tick per hour, one run at a time', but no generic scheduler framework exists. Each gateway background job is an independent setInterval registered in index.ts with its own env-gate flag.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:2100` — startProductAnalyticsRollupScheduler(); ... const { startBackstopClusterScheduler } = require('./services/jev/gates/backstop-cluster-gate'); if (startBackstopClusterScheduler()) ... const { startSlowSessionScheduler } = require('./services/jev/gates/slow-session-gate'); if (startSlowSessionScheduler()) ... const { startRoutineRunner } = require('./services/routine-runner/runner'); if (startRoutineRunner()) ...
- `exafyltd/vitana-platform:services/gateway/src/index.ts:2160` — const reconcilerEnabled = process.env.SELF_HEALING_RECONCILER_ENABLED !== 'false'; if (reconcilerEnabled) { const { startReconciler } = require('./services/self-healing-reconciler'); startReconciler(); } ... const { startPlanSparringReconciler } = require('./services/plan-sparring/reconciler'); if (startPlanSparringReconciler()) { ...

Suggestion: The plan should explicitly state it creates a new worker function (e.g. `startLiveSeriesMaterialiser`) in `services/gateway/src/services/live-series.ts`, registers it in `index.ts` behind an env-gate flag (e.g. `LIVE_SERIES_MATERIALISER_ENABLED`), and uses its own `setInterval` with a concurrency guard (the 'one run at a time' claim needs to be self-implemented, e.g. a boolean lock or Supabase advisory lock). Also clarify: `index.ts` is a hot file that every new worker touches — list it under shared files.

### R1-F3 [minor]

The plan does not mention OASIS events for series lifecycle operations (create, edit, cancel). The existing session creation path explicitly emits OASIS events, and governance requires lifecycle telemetry for significant state changes.

- `exafyltd/vitana-platform:services/gateway/src/services/room-session-manager.ts:142` — * 1. Call live_room_create_session RPC (validates host, creates session)
   * 2. If first session, create permanent Daily.co room
   * 3. Generate per-session Daily.co meeting tokens
   * 4. Emit OASIS event

Suggestion: Add to the gateway lane: series creation emits a `live.series.created` OASIS event, series edit emits `live.series.updated`, and series cancel emits `live.series.cancelled`, following the pattern already used for session lifecycle in room-session-manager.ts.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
