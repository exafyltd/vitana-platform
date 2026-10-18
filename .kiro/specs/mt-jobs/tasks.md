# Tasks — mt-jobs (WS6: jobs & events loop over active tenants)

Authoritative plan: `plan.md` (this folder). Design: `design.md`. Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval.

<!-- lane: jobs-env-prepare -->
## jobs-env-prepare — EventBridge schedules stop pinning one tenant (repo vitana-platform)

Allowed paths:
- `scripts/aws/setup-eventbridge-whats-new.sh`
- `scripts/aws/setup-eventbridge-push-dispatch.sh`
- `scripts/aws/setup-eventbridge-daily-feature-tip.sh`
- `scripts/aws/setup-eventbridge-cron-migration.sh`
- `docs/validation/`

- [ ] E1 Remove the single-tenant `TENANT_ID`/`DEFAULT_TENANT_ID` default from each script's EventBridge target
      input so the schedule fires with a tenant-less body; keep every other setting idempotent.
- [ ] E2 Document in each script header that the gateway resolves the active-tenant set (lane `jobs-tenant-loop`).
- [ ] E3 `docs/validation/<vtid>/`: plan copy, `scope.json`, apply runbook (Claude/owner applies against AWS; Kiro
      makes no mutating AWS call).

Acceptance: scripts are idempotent, dry-run clean; no `TENANT_ID` pinned in the target input; executor claude; no
gateway code changed in this lane.

<!-- lane: jobs-tenant-loop -->
## jobs-tenant-loop — shared mt-flags + active-tenant loop for heartbeat & scheduled notifications (repo vitana-platform)

Allowed paths:
- `services/gateway/src/services/mt-flags.ts`
- `services/gateway/src/services/jobs/job-tenant-loop.ts`
- `services/gateway/src/index.ts`
- `services/gateway/src/routes/scheduled-notifications.ts`
- `services/gateway/test/`
- `docs/validation/`

- [ ] L1 `mt-flags.ts`: `isJobsTenantLoopEnabled(env, settings)` (true only when `MT_RESOLUTION_V2` set AND
      `settings.feature_flags.mt.jobs_tenant_loop` truthy).
- [ ] L2 `jobs/job-tenant-loop.ts`: `activeTenantIds(sb)`, `tenantTimezone(sb, tenantId)` (fallback `Europe/Berlin`),
      `forEachActiveTenant(sb, fn)`, `resolveActorTenant(sb, identity)` (primary-tenant resolver, never `DEFAULT_TENANT_ID`).
- [ ] L3 Heartbeat loop (`index.ts:1842-1866`; `heartbeatTenantId` assignment `:1844`, `runHeartbeatCycle` call
      `:1853`): when the flag is on, run `runHeartbeatCycle` per active tenant; off, the single `DEFAULT_TENANT_ID`
      pass unchanged.
- [ ] L4 `scheduled-notifications.ts`: `getTenantId`-driven routes iterate `forEachActiveTenant` under the flag; off,
      unchanged. Per-user `getUserTimezone` untouched.
- [ ] L5 Vitest: flag matrix; `activeTenantIds` excludes `is_platform`/inactive; `tenantTimezone` fallback; each
      converted site = one `DEFAULT_TENANT_ID` pass off / two passes on with two active tenants.
- [ ] L6 `docs/validation/<vtid>/`: plan copy, `scope.json`, `staging-tests.json` (read-only health + active-count read).

Acceptance: `npm run build` (gateway) + the new Vitest green; `npm run test:operator` green; flag off is byte-for-byte
today; no migration; executor kiro.

<!-- lane: jobs-automation-actor-tenant -->
## jobs-automation-actor-tenant — automation events carry the actor's real tenant (repo vitana-platform)

Allowed paths:
- `services/gateway/src/routes/community.ts`
- `services/gateway/src/routes/match-feedback.ts`
- `services/gateway/src/routes/matchmaking.ts`
- `services/gateway/src/routes/admin-signups.ts`
- `services/gateway/src/services/orb-tools/groups-events-tools.ts`
- `services/gateway/test/`
- `docs/validation/`

- [ ] A1 Replace `process.env.DEFAULT_TENANT_ID` at the seven dispatch sites with `resolveActorTenant` (from
      `jobs-tenant-loop`) when the flag is on; off, unchanged.
- [ ] A2 Vitest: a non-Maxina actor's event carries that actor's tenant (on) and `DEFAULT_TENANT_ID` (off); never
      Maxina for a non-Maxina actor.
- [ ] A3 `docs/validation/<vtid>/`: plan copy, `scope.json`, `staging-tests.json`.

Acceptance: `npm run build` + Vitest green; depends on `jobs-tenant-loop` for the resolver; executor kiro.

<!-- lane: jobs-community-scan-tenant -->
## jobs-community-scan-tenant — community scan & memory backfill per active tenant (repo vitana-platform)

Allowed paths:
- `services/gateway/src/services/community-autopilot/scan-runner.ts`
- `services/gateway/src/routes/autopilot-recommendations.ts`
- `services/gateway/src/services/memory-embedding-backfill-loop.ts`
- `services/gateway/test/`
- `docs/validation/`

- [ ] C1 `runCommunityScan(sb, { tenantId?, … })` + `/community-scan` route loop active tenants under the flag (each
      tenant's members, that tenant's timezone); off, platform-wide as today.
- [ ] C2 Memory-embedding backfill loop takes its tenant set from `activeTenantIds(sb)` under the flag;
      `MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` stays the off/pinned override.
- [ ] C3 Vitest: two-tenant scan processes each tenant's members only; backfill tenant source = DB on / env off.
- [ ] C4 `docs/validation/<vtid>/`: plan copy, `scope.json`, `staging-tests.json`.

Acceptance: `npm run build` + Vitest green; depends on `jobs-tenant-loop`; executor kiro.
