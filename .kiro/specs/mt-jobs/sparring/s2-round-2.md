# Sparring round 2 — in_progress

Session: `76c3c99c-cf9a-4e72-aec4-4995d7755ae7` · plan hash `3862015f5b9b6f220dcd5a418cba65d106dc42e9b110d5988ae07e4c19b16cf3`

## Summary

The revision correctly addressed all six round-1 findings (verified against the pinned commit): resolvePrimaryTenant/TenantContext exist (tenant-context.ts:43/:24 over fetchPrimaryMembership), the schema/premise corrections are fixed, the OASIS event keeps backward-compatible top-level fields, the community-scan tenant filter partitions the existing is_primary set, the heartbeat registration gate change is correct, and the morning-brief double-dispatch reconciliation is sound. However, the heartbeat fan-out introduced in lane 2 has a new, unaddressed defect: runHeartbeatCycle's in-memory `lastHeartbeatRun` map is keyed only by automation id (not tenant), so looping tenants will silently skip heartbeat automations for every tenant after the first. Lane 3 also does not specify which userId to pass to resolvePrimaryTenant for the public `/log-result` route, where the actor identity has no user_id and the tenant belongs to `auth_user_id`.

## Findings

### R2-F1 [blocker]

The lane-2 heartbeat fan-out is broken by an in-memory dedup that is not tenant-scoped. runHeartbeatCycle (automation-executor.ts:392) tracks `lastHeartbeatRun[def.id]` (line 410, 418) keyed only by automation id, and skips an automation when `now - lastRun < intervalMs`. The plan says the heartbeat loop 'iterates the same tenant list per tick' — i.e. runHeartbeatCycle is invoked once per active tenant within each tick. Because the first tenant's cycle sets lastHeartbeatRun[def.id], every subsequent tenant in the same tick sees now-lastRun < interval and is SKIPPED, so tenants 2..N never execute any heartbeat automation (the interval always elapses between ticks for tenant 1 only, which runs first). This is a silent correctness failure under flag-on, precisely the multi-tenant behavior this change is meant to enable, and it is not covered by the stated tests ('loops the active tenants').

- `exafyltd/vitana-platform:services/gateway/src/services/automation-executor.ts:403` — const intervalMs = (def.triggerConfig?.intervalMinutes || 60) * 60 * 1000; const lastRun = lastHeartbeatRun[def.id] || 0; if (now - lastRun < intervalMs) { skipped.push(def.id); continue; }
- `exafyltd/vitana-platform:services/gateway/src/services/automation-executor.ts:386` — const lastHeartbeatRun: Record<string, number> = {}; // automation_id → last run timestamp ms ... export async function runHeartbeatCycle(tenantId: string)

Suggestion: Make the heartbeat dedup tenant-aware. Either (a) key `lastHeartbeatRun` by `tenantId:def.id` (e.g. a nested map) so each tenant's automations advance on their own interval, or (b) change runHeartbeatCycle to accept a tenant list and iterate tenants inside, keeping one per-tenant clock. Add a Jest test asserting two tenants both execute a due heartbeat automation within the same tick rather than the second being skipped.

### R2-F2 [major]

Lane 3 does not specify how to resolve the actor's tenant for the public `/log-result` route (admin-signups.ts:177). This route is `// public-route` with no `req.identity`, and the event `user.signup.completed` (line 210) carries `user_id: auth_user_id` — the tenant that matters is the NEW user's tenant, not any caller identity. The plan's `resolveActorTenant(identity)` = 'verified identity's tenant_id first, else resolvePrimaryTenant(userId)' does not say WHICH userId is passed: there is no identity tenant here, and resolving against the admin/caller would tag the event to the wrong tenant (or, if no identity at all, `resolvePrimaryTenant` would need the new user's id, which the plan never states).

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:176` — // public-route
router.post('/log-result', async (req: Request, res: Response) => {
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:203` — if (status === 'onboarded' && auth_user_id) { const tenantId = process.env.DEFAULT_TENANT_ID; if (tenantId) { ... dispatchEvent(tenantId, 'user.signup.completed', { user_id: auth_user_id, attempt_id })

Suggestion: Specify that for `/log-result` (and any other public route among the six sites) the resolvePrimaryTenant target is the new user (`auth_user_id`) rather than a caller identity, and add a Jest case asserting the event is tagged to the new user's primary tenant (flag on) and DEFAULT_TENANT_ID (flag off). Confirm each of the six sites has an `identity` (or a concrete user id) before assuming `identity.tenant_id` is available.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
