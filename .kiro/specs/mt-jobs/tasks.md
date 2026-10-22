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
- `services/gateway/src/routes/automations.ts`
- `services/gateway/src/services/jobs/job-tenant-loop-repository.ts`
- `services/gateway/src/services/automation-executor.ts`
- `services/gateway/test/`
- `docs/validation/`

- [ ] L1 `mt-flags.ts`: `isJobsTenantLoopEnabled(env, settings)` (true only when `MT_RESOLUTION_V2` set AND
      `settings.feature_flags.mt.jobs_tenant_loop` truthy; the key is new inside the existing `tenant_settings.feature_flags`
      JSONB, `20260412300000_tenant_settings.sql:12`).
- [ ] L2 `jobs/job-tenant-loop-repository.ts` (`fetchActiveTenants` = `tenants.select('id').eq('is_active', true)
      .eq('is_platform', false)`; `fetchTenantSettings(ids)` = `tenant_settings.select('tenant_id, timezone,
      feature_flags').in('tenant_id', ids)`) + `jobs/job-tenant-loop.ts`: `activeTenantIds(sb)` (flag-on active
      non-platform tenants ∪ `DEFAULT_TENANT_ID`), `tenantTimezone(settings)` (`Europe/Berlin` only when the tenant has
      no `tenant_settings` row), `forEachActiveTenant(sb, fn)`, `resolveJobTenants(req, sb)` (body/identity tenant ⇒
      that one; none + master on ⇒ `activeTenantIds`; none + off ⇒ `[DEFAULT_TENANT_ID]`), and
      `resolveActorTenant({ tenantId, userId })` (known tenant, else the existing `resolvePrimaryTenant(userId)` from
      `services/tenancy/tenant-context.ts:43`; unresolvable ⇒ null, never `DEFAULT_TENANT_ID`, never a new
      `user_tenants` read) and `jwtSubject(token)` (the `sub` decode the routes already do, `community.ts:287`).
- [ ] L3 Heartbeat loop (`index.ts:1841-1866`; assignment `:1844`, gate `:1845`, `runHeartbeatCycle` `:1853`,
      `setInterval` registered once at startup `:1849`): gate becomes `heartbeatEnabled && (heartbeatTenantId ||
      MT_RESOLUTION_V2 === 'true')`; the tenant list is evaluated INSIDE each tick, never at init; empty list ⇒ no-op.
      Master off ⇒ today's single `DEFAULT_TENANT_ID` pass. A mid-flight flip takes effect next tick.
- [ ] L3b `services/automation-executor.ts`: re-key `lastHeartbeatRun` (`:386`; read `:405`, writes `:418`, `:424`) as
      `` `${tenantId}:${def.id}` `` so each tenant keeps its own heartbeat clock inside `runHeartbeatCycle` (`:392`);
      single-tenant behaviour unchanged. Jest: two tenants both run a due heartbeat automation in one tick.
- [ ] L4 `automations.ts` `/cron/:id` (`:162-168`, `getAdminTargetTenantId` `:64-66`) and the `scheduled-notifications.ts`
      `getTenantId`-driven routes use `resolveJobTenants`: explicit tenant ⇒ one pass (so AP-0501 → `/morning-briefing`,
      `engagement-events.ts:439-442`, never re-fans out); no tenant ⇒ fan-out (on) / `DEFAULT_TENANT_ID` (off).
      Per-user `getUserTimezone` and the `findRecentlyNotified` idempotency check (`scheduled-notifications.ts:497-499`)
      untouched.
- [ ] L5 Jest: flag matrix; `activeTenantIds` excludes `is_platform`/inactive and always keeps `DEFAULT_TENANT_ID`;
      `tenantTimezone` fallback; `resolveJobTenants` precedence; `/cron/AP-0501` flag on with two tenants ⇒ two
      `executeAutomation` calls and each nested `/morning-briefing` runs once for its tenant; each converted site =
      one `DEFAULT_TENANT_ID` pass off / two passes on; heartbeat registered with master on and no `DEFAULT_TENANT_ID`;
      a flag flipped off between two ticks stops the tenant loop on the next tick with no restart; a user with a
      scheduler-written `morning_briefing_ready` row in that tenant within 20 h is skipped.
- [ ] L6 `docs/validation/<vtid>/`: plan copy, `scope.json`, `staging-tests.json` (read-only health + active-count read).

Acceptance: `npm run build` (gateway) + the new Jest tests green; `npm run test:operator` green; flag off is byte-for-byte
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

- [ ] A1 Replace `process.env.DEFAULT_TENANT_ID` with `resolveActorTenant` (from `jobs-tenant-loop`, built on the
      existing `resolvePrimaryTenant`) when the flag is on at the six direct-pin sites (`community.ts:274,382,482`,
      `match-feedback.ts:280`, `matchmaking.ts:576`, `admin-signups.ts:205`) and the one fallback site
      `groups-events-tools.ts:357-360` (`id.tenant_id || DEFAULT_TENANT_ID`); off, unchanged. Actor per site:
      `community.ts:382` ⇒ `{ tenantId: req.identity.tenant_id, userId: req.identity.user_id }` (`requireAuth`);
      `community.ts:274`, `community.ts:482`, `match-feedback.ts:280`, `matchmaking.ts:576` (raw bearer, no identity)
      ⇒ `{ userId: jwtSubject(token) }`, read after the route's user-scoped Supabase call succeeded;
      `admin-signups.ts:205` (public `/log-result`) ⇒ `{ userId: auth_user_id }` (the new user); `groups-events-tools.ts:360`
      ⇒ `{ tenantId: id.tenant_id, userId: id.user_id }`. Unresolvable ⇒ no tenant dispatch, logged. Annotate the
      fallback site: its `id.tenant_id`-present path must stay un-regressed.
- [ ] A2 Jest: a non-Maxina actor's event carries that actor's tenant (on) and `DEFAULT_TENANT_ID` (off); never
      Maxina for a non-Maxina actor; `resolvePrimaryTenant` not `'found'` ⇒ no Maxina tag; `/log-result` tags
      `auth_user_id`'s primary tenant; a raw-bearer route resolves the token `sub`'s tenant. Dedicated
      `groups-events-tools` case: an `id.tenant_id`-present dispatch keeps that tenant on both flag states.
- [ ] A3 `docs/validation/<vtid>/`: plan copy, `scope.json`, `staging-tests.json`.

Acceptance: `npm run build` + Jest green; depends on `jobs-tenant-loop` for the resolver; executor kiro.

<!-- lane: jobs-community-scan-tenant -->
## jobs-community-scan-tenant — community scan & memory backfill per active tenant (repo vitana-platform)

Allowed paths:
- `services/gateway/src/services/community-autopilot/scan-runner.ts`
- `services/gateway/src/routes/autopilot-recommendations.ts`
- `services/gateway/src/services/memory-embedding-backfill-loop.ts`
- `services/gateway/test/`
- `docs/validation/`

- [ ] C1 `runCommunityScan(sb, { tenantId?, … })`: with `tenantId` the member query (`scan-runner.ts:265`) adds
      `.eq('tenant_id', tenantId)` to today's `.eq('is_primary', true)` — each member scanned once, under their primary
      tenant; the per-member timezone chain (`:274-284`) keeps today's order with that tenant's `tenant_settings.timezone`
      as the final default. The `/community-scan` route loops active tenants under the flag; off, platform-wide as
      today.
- [ ] C1b ONE `community_autopilot.scan.completed` event per tick (`autopilot-recommendations.ts:2299-2309`): the six
      top-level fields keep today's names/types (`enabled`, `dry_run`, and the four counts SUMMED) plus
      `per_tenant: [{ tenant_id, members_considered, members_due, members_scanned, rows_inserted }]`; flag off ⇒
      payload identical to today. The route response keeps the same top-level summary fields.
- [ ] C2 Memory-embedding backfill loop takes its tenant set from `activeTenantIds(sb)` under the flag;
      `MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` stays the off/pinned override.
- [ ] C3 Jest: two-tenant scan, a member primary in A and secondary in B is scanned only in A's pass; members whose
      primary tenant is inactive/platform are in no pass (flag on); exactly ONE event per tick with backward-compatible
      top-level totals (the existing `test/routes/autopilot-recommendations.test.ts:1655` assertion stays green);
      backfill tenant source = DB on / env off.
- [ ] C4 `docs/validation/<vtid>/`: plan copy, `scope.json`, `staging-tests.json`.

Acceptance: `npm run build` + Jest green; depends on `jobs-tenant-loop`; executor kiro.
