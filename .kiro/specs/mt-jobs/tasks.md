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

- [ ] E1 Stop each script pinning a tenant, per mechanism: `whats-new.sh` + `daily-feature-tip.sh` — drop
      `TENANT_ID` from the Lambda `--environment Variables` (`whats-new.sh:204,218`) AND change the inline handler
      body `JSON.stringify({ tenant_id: process.env.TENANT_ID })` → `JSON.stringify({})` (`whats-new.sh:158`,
      `daily-feature-tip.sh:190`); `cron-migration.sh` — drop `"tenant_id":"$TENANT_ID"` from each of the ~26 Input
      bodies (`:156-188`); `push-dispatch.sh` — no change (pins no tenant). Keep every other setting idempotent.
- [ ] E2 Document in each changed script header that the gateway now resolves the active-tenant set
      (lane `jobs-tenant-loop`), and that the Lambda config AND code are both re-applied against AWS.
- [ ] E3 `docs/validation/<vtid>/`: plan copy, `scope.json`, apply runbook (Claude/owner applies against AWS; Kiro
      makes no mutating AWS call).

Acceptance: scripts are idempotent, dry-run clean; no `TENANT_ID` in any Lambda env block, inline handler body or
schedule Input body of the three tenant-pinning scripts; `push-dispatch.sh` unchanged; executor claude; no gateway
code changed in this lane.

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
- [ ] L3 Heartbeat loop (`index.ts:1840-1866`; `heartbeatTenantId` assignment `:1844`, `runHeartbeatCycle` call
      `:1853`, `setInterval` registered once at startup `:1848`): evaluate `isJobsTenantLoopEnabled` + `activeTenantIds`
      INSIDE each tick (per-tenant settings fetched on that tick), never at init; flag on ⇒ `runHeartbeatCycle` per
      active tenant, off ⇒ the single `DEFAULT_TENANT_ID` pass unchanged. A mid-flight flip takes effect next tick.
- [ ] L4 `scheduled-notifications.ts`: `getTenantId`-driven routes iterate `forEachActiveTenant` under the flag; off,
      unchanged. Per-user `getUserTimezone` untouched.
- [ ] L5 Vitest: flag matrix; `activeTenantIds` excludes `is_platform`/inactive; `tenantTimezone` fallback; each
      converted site = one `DEFAULT_TENANT_ID` pass off / two passes on with two active tenants; a flag flipped off
      between two ticks stops the tenant loop on the next tick with no restart (per-tick evaluation, R1-F5).
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

- [ ] A1 Replace `process.env.DEFAULT_TENANT_ID` with `resolveActorTenant` (from `jobs-tenant-loop`) when the flag
      is on at the six direct-pin sites (`community.ts:274,382,482`, `match-feedback.ts:280`, `matchmaking.ts:576`,
      `admin-signups.ts:205`) and the one fallback site `groups-events-tools.ts:357-360`
      (`id.tenant_id || DEFAULT_TENANT_ID`); off, unchanged. Annotate the fallback site: its `id.tenant_id`-present
      path must stay un-regressed.
- [ ] A2 Vitest: a non-Maxina actor's event carries that actor's tenant (on) and `DEFAULT_TENANT_ID` (off); never
      Maxina for a non-Maxina actor. Dedicated `groups-events-tools` case: an `id.tenant_id`-present dispatch keeps
      that tenant on both flag states (no regression of the already-correct path).
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
      tenant's members, that tenant's timezone); off, platform-wide as today. Emit ONE aggregated
      `community_autopilot.scan.completed` OASIS event after the full loop (collect each tenant's `ScanRunSummary`
      into the payload), replacing the current per-call emit (`autopilot-recommendations.ts:2299-2309`) — never N
      events per tick.
- [ ] C2 Memory-embedding backfill loop takes its tenant set from `activeTenantIds(sb)` under the flag;
      `MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` stays the off/pinned override.
- [ ] C3 Vitest: two-tenant scan processes each tenant's members only and emits exactly ONE aggregated OASIS event
      per tick (not one per tenant); backfill tenant source = DB on / env off.
- [ ] C4 `docs/validation/<vtid>/`: plan copy, `scope.json`, `staging-tests.json`.

Acceptance: `npm run build` + Vitest green; depends on `jobs-tenant-loop`; executor kiro.
