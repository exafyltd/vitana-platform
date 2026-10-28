# Design — mt-jobs (WS6)

## What exists (read these, do not copy them)
- Program plan + decision register: `docs/MULTI-TENANT-PLAN.md` §6 (WS6).
- Migration order / applied status: `docs/multitenancy/MIGRATION-QUEUE.md` (all 8 M0 migrations applied; mt-jobs
  adds none).
- Active-tenant columns (applied): `supabase/migrations/20261014000100_vtid_05149_tenants_default_platform_flags.sql`
  (`tenants.is_active` already existed; `is_default`/`is_platform` added). Timezone (applied):
  `supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql` (`tenant_settings.timezone`,
  `pg_timezone_names`-validated).
- Single-tenant job sites (verified 2026-10-15):
  - Heartbeat loop: `services/gateway/src/index.ts:1838-1866` (`DEFAULT_TENANT_ID`, `runHeartbeatCycle`).
  - Scheduled notifications: `services/gateway/src/routes/scheduled-notifications.ts` — `getTenantId` (`:105`),
    `/night-push` (`:1525`), `/daily-pace-notifications`, `/whats-new`, `/recommendation-expiry`, `/signal-cleanup`,
    `/welcome-team-tick`. Per-user tz already resolved via `getUserTimezone` (`daily-pace-service.ts`).
  - Community scan: `services/gateway/src/routes/autopilot-recommendations.ts:2281` →
    `services/gateway/src/services/community-autopilot/scan-runner.ts:255` (`runCommunityScan`).
  - Morning brief: `services/gateway/src/services/guide/morning-brief-scheduler.ts:132` (already reads each user's
    `tenant_id`; only its candidate query needs tenant-loop scoping).
  - Memory backfill loop: `services/gateway/src/services/memory-embedding-backfill-loop.ts:38-44`
    (`MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` env list).
  - Automation-event actor tenant: `community.ts:274,382,482`, `match-feedback.ts:280`, `matchmaking.ts:576`,
    `admin-signups.ts:205`, `services/orb-tools/groups-events-tools.ts:360`.
- EventBridge scripts: `scripts/aws/setup-eventbridge-whats-new.sh:40` (`TENANT_ID` in target input),
  `setup-eventbridge-push-dispatch.sh`, `setup-eventbridge-daily-feature-tip.sh`, `setup-eventbridge-cron-migration.sh`.

## Design per lane

### jobs-env-prepare (executor claude — governance: EventBridge infra)
Remove the single-tenant `TENANT_ID` default from the four `setup-eventbridge-*.sh` target inputs so each schedule
fires with a tenant-less body; the gateway loop (lane 2) expands it. No gateway code reads change here. Applied
against the AWS estate by Claude/owner, never by a Kiro mutating AWS call.

### jobs-tenant-loop (DB-free code, seat jtadic)
- `services/gateway/src/services/mt-flags.ts`: `isJobsTenantLoopEnabled(env, settings)` — true only when
  `env.MT_RESOLUTION_V2` is set AND `settings.feature_flags?.mt?.jobs_tenant_loop` is truthy. The shared flag module
  mt-launch imports.
- `services/gateway/src/services/jobs/job-tenant-loop-repository.ts`: the only DB access — `fetchActiveTenants`,
  `fetchTenantSettings(ids)` (`tenant_settings.tenant_id, timezone, feature_flags`; table `20260412300000`, timezone
  `20261014000400:44`).
- `services/gateway/src/services/jobs/job-tenant-loop.ts`: `activeTenantIds(sb)` (flag-on active non-platform
  tenants ∪ `DEFAULT_TENANT_ID`), `tenantTimezone(settings)`, `forEachActiveTenant(sb, fn)` (one context per tenant),
  `resolveJobTenants(req, sb)` (explicit tenant ⇒ one pass; none ⇒ fan-out on / `DEFAULT_TENANT_ID` off) and
  `resolveActorTenant({ tenantId, userId })` (known tenant, else the existing `resolvePrimaryTenant(userId)` from
  `services/tenancy/tenant-context.ts:43`; never `DEFAULT_TENANT_ID`, no new `user_tenants` read; the per-site actor is
  `req.identity` only at `community.ts:382`, the bearer token `sub` at the four raw-bearer routes, the new user
  `auth_user_id` at the public `/log-result`, and the ORB tool identity at `groups-events-tools.ts:360`).
- `services/automation-executor.ts`: `lastHeartbeatRun` (`:386`) re-keyed `${tenantId}:${def.id}` so each tenant has its own
  heartbeat clock in a multi-tenant tick.
- Convert the heartbeat loop (registration gate `index.ts:1845` also opens on `MT_RESOLUTION_V2`), the automation cron
  route `automations.ts:162-168` and the `scheduled-notifications.ts` routes through `resolveJobTenants` — the fan-out
  happens at exactly one level (AP-0501 → `/morning-briefing` carries its tenant); off, the single
  `DEFAULT_TENANT_ID` pass unchanged.

### jobs-automation-actor-tenant (DB-free code, seat jtadic)
The seven dispatch sites call `resolveActorTenant` (lane 2) when the flag is on; off, keep `DEFAULT_TENANT_ID`.
Depends on lane 2 for the resolver.

### jobs-community-scan-tenant (DB-free code, seat jtadic)
`runCommunityScan(sb, { tenantId?, … })` (member query `is_primary` AND `tenant_id` — each member once, under their
primary tenant) + the `/community-scan` route loop active tenants under the flag, emitting ONE event per tick that
keeps today's six top-level payload fields (counts summed) plus `per_tenant`; the
memory-backfill loop's tenant source becomes `activeTenantIds(sb)` under the flag (env override otherwise). Depends
on lane 2.

## Rules every successor follows
1. **Dark by default:** every merged change is off unless `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.jobs_tenant_loop`
   are set, because PUBLISH promotes the whole staging build. The flag flip is an M2 step after a second real tenant
   exists.
2. **No migration:** mt-jobs reads M0 columns only. A later premise that genuinely needs a column takes the next
   version in `20261101100000`–`20261101105959` and adds a MIGRATION-QUEUE row in the same PR.
3. **Production read-only** for every session and test (CLAUDE.md 31–32, 48); the executor never writes to Supabase
   or AWS (collaboration §7a). The EventBridge/AWS change is applied by Claude/owner.
4. **Keep the single-tenant path:** never remove the `DEFAULT_TENANT_ID` fallback in this spec — a half-rolled fleet
   must still work with the flag off.
5. Test/service accounts invisible to members (rules 43–45); AI-stage routing Bedrock-only, no Google beyond the
   carve-outs; i18n DE-first du-form for any user-visible string (none expected here — these are backend jobs).
   Keep `npm run test:operator` (rule 42e) green.
