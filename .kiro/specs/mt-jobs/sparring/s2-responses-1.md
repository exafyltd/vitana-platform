# Responses to sparring round 1 (session 2, `76c3c99c-cf9a-4e72-aec4-4995d7755ae7`)

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: services/tenancy/tenant-context.ts:43 exports resolvePrimaryTenant (over fetchPrimaryMembership, tenant-context-repository.ts:16) and :24 TenantContext, shipped under VTID-05149. The 'Depends on' entry now lists it as already shipped, and the lane-3 resolver resolveActorTenant(identity) = the verified identity tenant, else the imported resolvePrimaryTenant(userId); a status other than 'found' dispatches without a tenant override and logs, never tags Maxina. The 'falls back to the primary user_tenants row read directly' wording is removed from plan.md, design.md, tasks.md L2/A1/A2 and the jobs-automation-actor-tenant lane.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified the schema in the migrations: supabase/migrations/20260412300000_tenant_settings.sql:8-12 creates public.tenant_settings (tenant_id UUID PRIMARY KEY REFERENCES tenants(id), feature_flags JSONB NOT NULL DEFAULT '{}'); 20261014000400_vtid_05150_tenant_brand_pack.sql:44 adds timezone text NOT NULL DEFAULT 'Europe/Berlin' (validated against pg_timezone_names at :93). Existing gateway reads of the table: admin-tenants-repository.ts:64 and billing-repository.ts:288 (select('tenant_id, feature_flags')). feature_flags.mt.jobs_tenant_loop is a new key inside that JSONB (absent = off), so no schema change. The plan now cites these lines and names the read path: a new services/jobs/job-tenant-loop-repository.ts with fetchActiveTenants (tenants.select('id').eq('is_active', true).eq('is_platform', false)) and fetchTenantSettings(ids) (tenant_settings.select('tenant_id, timezone, feature_flags').in('tenant_id', ids)), one query each per tick; the 'Europe/Berlin' fallback applies only to a tenant without a tenant_settings row. Repository added to the jobs-tenant-loop lane paths. Updated plan.md Problem data paragraph + lane 2, design.md, tasks.md L1/L2.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified scan-runner.ts:265 selects user_tenants.user_id WHERE is_primary = true (limit 5000) and scanMember (called at :302) takes no tenant. Decision: a tenant pass adds .eq('tenant_id', tenantId) to the existing is_primary filter, so each member is scanned exactly once per tick under their PRIMARY tenant and the passes partition today's member set (no double scan, no second row set for a secondary membership, matching today's one-scan-per-member semantics). A member primary in A and secondary in B is scanned in A's pass only; members whose primary tenant is inactive or the platform tenant are in no pass under flag-on. The per-member clock keeps today's chain (:274-284, reminders.user_tz then memory_facts timezone via resolveUserTimezone) with that tenant's tenant_settings.timezone as the final default. Jest cases for both membership shapes added. Updated plan.md lane 4, design.md, tasks.md C1/C3 and the lane body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified autopilot-recommendations.ts:2299-2309 emits community_autopilot.scan.completed with scalar payload enabled, dry_run, members_considered, members_due, members_scanned, rows_inserted. Searched consumers: only services/gateway/test/routes/autopilot-recommendations.test.ts:1655 (asserts the event type) and the VTID-04505 OASIS_PROOF (docs/validation/VTID-04505/acceptance.md:57, lists those scalar fields). Fix: the one event per tick KEEPS the six top-level fields with the same names and types (enabled/dry_run from the run, the four counts summed over tenants) and ADDS per_tenant: [{ tenant_id, members_considered, members_due, members_scanned, rows_inserted }]; flag off the payload is identical to today; the route JSON response keeps the same top-level summary fields. A Jest case asserts the backward-compatible totals and the existing :1655 assertion stays green. Updated plan.md lane 4 + Tests, design.md, tasks.md C1b/C3 and the lane body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F6",
    "disposition": "accepted",
    "rationale": "Verified index.ts:1843-1845: heartbeatEnabled && heartbeatTenantId gates registration, so with no DEFAULT_TENANT_ID the interval is never registered (setInterval at :1849, cycle call :1853). Fix: the gate becomes heartbeatEnabled && (heartbeatTenantId || process.env.MT_RESOLUTION_V2 === 'true'); the tenant list is evaluated inside each tick and an empty list is a no-op; with the master off the gate is exactly today's. Jest covers master on + no DEFAULT_TENANT_ID (registered, loops active tenants) and master off + no DEFAULT_TENANT_ID (not registered). Also corrected the setInterval citation from :1848 to :1849. Updated plan.md Problem 1 + lane 2 + Tests, design.md, tasks.md L3/L5, lane body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F7",
    "disposition": "accepted",
    "rationale": "Verified both paths. The in-process scheduler is OFF by default (MORNING_BRIEF_ENABLED defaults to 'false', morning-brief-scheduler.ts:46). The LIVE path is EventBridge autopilot-morning-briefing (setup-eventbridge-cron-migration.sh:157) -> POST /api/v1/automations/cron/AP-0501 (automations.ts:162-168, tenant via getAdminTargetTenantId :64-66) -> runMorningBriefing (automation-handlers/engagement-events.ts:431-445) -> POST /scheduled-notifications/morning-briefing with an explicit { tenant_id }. Guard: the route skips users with a morning_briefing_ready user_notifications row for that tenant in the last 20 h (findRecentlyNotified scheduled-notifications.ts:497-499 -> scheduled-notifications-repository.ts:47-57), and the scheduler writes exactly such a row (notifyUser(u.user_id, u.tenant_id, 'morning_briefing_ready', ...) morning-brief-scheduler.ts:150-153 -> insertUserNotification notification-service-repository.ts:93), so a scheduler send is never duplicated by the route. The reverse order (the scheduler dedups only on user_proactive_touches, morning-brief-scheduler-repository.ts:28-33) is a pre-existing property of running both paths, unchanged by mt-jobs, kept off operationally by MORNING_BRIEF_ENABLED=false; stated in the plan. Because the live path enters through /automations/cron/:id, lane 2 now also converts that route and uses one tenant-source rule (explicit tenant => one pass; none => fan-out on / DEFAULT_TENANT_ID off), so the fan-out happens at exactly one level and AP-0501's nested /morning-briefing call never re-fans out. routes/automations.ts added to the jobs-tenant-loop paths (no other lane claims it). Jest: the skip case and the one-level fan-out. Updated plan.md Problems 1b/4 + lane 2 + Tests, design.md, tasks.md L4/L5, lane body.",
    "deferred_to": null
  }
]
```
