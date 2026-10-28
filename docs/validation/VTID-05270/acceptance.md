# VTID-05270 — mt-jobs/jobs-tenant-loop acceptance

Lane acceptance: `.kiro/specs/mt-jobs/tasks.md` group `jobs-tenant-loop` (copy of the plan: `plan.md` here).
Suite: `services/gateway/test/vtid-05270-job-tenant-loop.test.ts` (31 tests). Output: `outputs/jest-vtid-05270.txt`.
Everything ships dark: `MT_RESOLUTION_V2` unset ⇒ today's single `DEFAULT_TENANT_ID` path.

AC-1 — `isJobsTenantLoopEnabled(env, settings)` is on only when `MT_RESOLUTION_V2=true` AND `feature_flags.mt.jobs_tenant_loop` is true.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › isJobsTenantLoopEnabled

AC-2 — `activeTenantIds` = active, non-platform, flagged tenants ∪ `DEFAULT_TENANT_ID`, one query each for `tenants` and `tenant_settings`; master off ⇒ `[DEFAULT_TENANT_ID]` with no DB read; a failed read degrades to `[DEFAULT_TENANT_ID]`.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › activeTenantIds

AC-3 — `tenantTimezone` uses `tenant_settings.timezone`, `Europe/Berlin` without a row or with an invalid zone.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › tenantTimezone

AC-4 — Tenant-source rule (`resolveJobTenants`): an identity or body tenant ⇒ exactly one pass on both flag states; no tenant ⇒ `DEFAULT_TENANT_ID` (off) / active tenants (on).
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › resolveJobTenants

AC-5 — `resolveActorTenant` / `jwtSubject`: a known tenant wins, else `resolvePrimaryTenant`; unresolvable ⇒ null, never `DEFAULT_TENANT_ID`.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › resolveActorTenant / jwtSubject

AC-6 — Heartbeat: registration gate is today's without the master and also opens on `MT_RESOLUTION_V2=true` without `DEFAULT_TENANT_ID`; the tenant list is evaluated inside each tick (a flag flipped off stops that tenant on the next tick, no restart); an empty list is a no-op.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › heartbeat loop

AC-7 — Per-tenant heartbeat clock: `lastHeartbeatRun` is keyed `${tenantId}:${def.id}`, so two tenants both run a due automation in one tick and then each waits its own interval.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › runHeartbeatCycle per-tenant clock

AC-8 — `POST /api/v1/automations/cron/:id` fans out over active tenants only when the master is on and no tenant is given; master off ⇒ one `DEFAULT_TENANT_ID` pass with the unchanged response; no tenant anywhere ⇒ 400 as today.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › /automations/cron/:id
ROUTE_MOUNT: No new route and no new mount. `router.post('/cron/:id', requireInternalOrAdmin, async …)` in `services/gateway/src/routes/automations.ts` is the existing handler, now delegating to `cronJob` (the old body wrapped in `withJobTenants`), so the VTID-04349 auth-gate pin still matches; the router stays mounted by `mountRouterSync(app, '/api/v1/automations', automationsRouter, { owner: 'automations' })` in `services/gateway/src/index.ts` (unchanged by this PR). The diff shows the `router.post(` line only because the handler argument was wrapped.
FINAL_URL: POST {gateway}/api/v1/automations/cron/:id (pre-existing, unchanged)
CURL_PROOF: N/A for a new endpoint — the path, method, auth middleware and mount are unchanged. Staging verification is read-only (rule 48), so no POST is sent to staging; the route is driven end to end through its Express router in the Jest suite above, and `staging-tests.json` checks `GET /alive` (the build boots with the new modules) after the staging deploy.

AC-9 — The 12 `getTenantId`-driven `scheduled-notifications` routes (`/morning-briefing`, `/daily-pace-notifications`, `/diary-reminder`, `/daily-feature-tip`, `/whats-new`, `/weekly-digest`, `/weekly-summary`, `/weekly-reflection`, `/upcoming-events`, `/recommendation-expiry`, `/signal-cleanup`, `/night-push`) use the same tenant-source rule: master off ⇒ one `DEFAULT_TENANT_ID` pass, unchanged response; master on and no tenant ⇒ one pass per active tenant; a nested call with a tenant (AP-0501 → `/morning-briefing`) runs once for that tenant; `findRecentlyNotified` still skips a user with a scheduler-written `morning_briefing_ready` row in that tenant within 20 h.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › /scheduled-notifications routes
ROUTE_MOUNT: No new route and no new mount. The 12 existing `router.post(…)` handlers in `services/gateway/src/routes/scheduled-notifications.ts` are wrapped in `jobRoute(...)` (`withJobTenants`); the router stays mounted by `mountRouterSync(app, '/api/v1/scheduled-notifications', scheduledNotificationsRouter, { owner: 'scheduled-notifications' })` in `services/gateway/src/index.ts` (unchanged by this PR).
FINAL_URL: POST {gateway}/api/v1/scheduled-notifications/{morning-briefing|daily-pace-notifications|diary-reminder|daily-feature-tip|whats-new|weekly-digest|weekly-summary|weekly-reflection|upcoming-events|recommendation-expiry|signal-cleanup|night-push} (pre-existing, unchanged)
CURL_PROOF: N/A for a new endpoint — paths, methods, auth and mount are unchanged. Staging verification is read-only (rule 48): after the staging deploy `staging-tests.json` sends `GET {staging gateway}/api/v1/scheduled-notifications/health` and expects `200` JSON (the converted router is mounted and answers). No POST is sent to staging; the fan-out is proven by the Jest suite above.

AC-10 — Flag off is today: with `MT_RESOLUTION_V2` unset every converted site gets exactly the old tenant source and the live `res`, with no DB read.
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › activeTenantIds › master off ⇒ [DEFAULT_TENANT_ID] with no DB read
TEST: services/gateway/test/vtid-05270-job-tenant-loop.test.ts › heartbeat loop › master off ⇒ one DEFAULT_TENANT_ID cycle per tick, no DB read

OASIS_IMPACT: no — this lane emits no new OASIS event and changes no event payload.
