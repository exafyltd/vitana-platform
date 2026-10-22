# VTID-05270 — mt-jobs/jobs-tenant-loop evidence

Base: origin/main 44f819d24. Lane acceptance: `.kiro/specs/mt-jobs/tasks.md` group `jobs-tenant-loop` (L1–L6).

## What changed
- L1 `services/mt-flags.ts`: `isMtResolutionV2Enabled`, `isJobsTenantLoopEnabled(env, settings)`.
- L2 `services/jobs/job-tenant-loop-repository.ts` (only DB access: `fetchActiveTenants`, `fetchTenantSettings`) and
  `services/jobs/job-tenant-loop.ts` (`activeTenantIds`, `tenantTimezone`, `forEachActiveTenant`, `resolveJobTenants`,
  `resolveActorTenant`, `jwtSubject`, `withJobTenants`, heartbeat helpers). The live key column is `tenants.tenant_id`
  (the plan text says `id`; every existing gateway read uses `tenant_id`).
- L3 `index.ts`: registration gate `shouldRegisterHeartbeat` (today's gate, also open on `MT_RESOLUTION_V2=true`); each
  tick calls `runHeartbeatTick`, which evaluates the tenant list inside the tick.
- L3b `automation-executor.ts`: `lastHeartbeatRun` keyed `${tenantId}:${def.id}` at all three sites.
- L4 `automations.ts` `/cron/:id` and the 12 `getTenantId`-driven `scheduled-notifications.ts` routes wrapped in
  `withJobTenants`. Master off ⇒ the handler gets exactly the old tenant source and the live response. Explicit tenant ⇒
  one pass. Fan-out (2+ tenants) answers `{ ok, fanout: true, per_tenant: [...] }`. Per-user timezone and
  `findRecentlyNotified` are untouched inside each pass.
- No migration.

## Red on base / green on head
- Base 44f819d24: `test/vtid-05270-job-tenant-loop.test.ts` cannot run (it imports `src/services/mt-flags` and
  `src/services/jobs/job-tenant-loop`, which do not exist on base) ⇒ red.
- Head: `npx jest test/vtid-05270-job-tenant-loop.test.ts` ⇒ 31 passed, 0 failed.

## Regression runs (head)
- `npx jest` on vtid-04786 heartbeat, scheduled-notifications night-push / whats-new / daily-feature-tip, daily-pace-service,
  automations-wallet-balance, vtid-04510, vtid-05048-s4, vtid-04962, vtid-04892, vtid-05099, vtid-05205, native-push
  routing + golden (vtid-05177), vtid-04465 operator: 321 passed, 4 failed in one parallel run. Three of the four were
  timeouts under load (daily-pace, companion, welcome-team) and pass on re-run (daily-pace with `-i`: 28/28; the four-suite
  re-run: 167 passed, 1 failed).
- The remaining failure, `vtid-04465-operator-pipeline-regression` › "the runner jest targets include every suite that names
  app.js", fails identically on base 44f819d24 (base run: 70 passed, 1 failed). The test expects
  `test/command-hub/cache-bust-pin.test.ts` but gets `test\command-hub\cache-bust-pin.test.ts`: a Windows path-separator
  issue in the local run, unrelated to this lane. CI (Linux) is the authority.
- `npx tsc --noEmit -p .` (services/gateway): exit 0, no output.

## Flag off is today
`MT_RESOLUTION_V2` unset ⇒ `withJobTenants` calls the handler with `getTenantId(req)` / `getAdminTargetTenantId(req)`
and the live `res` (no DB read, pinned by test); the heartbeat runs one `DEFAULT_TENANT_ID` cycle per tick (pinned by
test); the per-tenant clock with one tenant gives the same skip/execute sequence as before.
