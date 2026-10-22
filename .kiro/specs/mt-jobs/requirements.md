# Requirements — mt-jobs (WS6: jobs & events loop over active tenants)

Program: `docs/MULTI-TENANT-PLAN.md` (v5.1, §6 WS6). This spec is the Kiro-readable hand-off of that
workstream; it links the program's records instead of copying them.

## Program position
- **Predecessors:** mt-identity (WS1) — `resolvePrimaryTenant()` + `TenantContext` (soft dependency; lane 3
  falls back to a direct primary-membership read until it ships). Done M0: `tenants.is_active/is_default/is_platform`
  (VTID-05149), `tenant_settings.timezone` (VTID-05150) — already applied, read-only here.
- **Successors:** mt-launch (WS8) consumes the shared `mt-flags.ts` and `job-tenant-loop.ts` added here for its
  APIs and the M2 flag flips.

## Program goal
Every scheduled job and automation event runs per active tenant with that tenant's timezone, instead of a single
`DEFAULT_TENANT_ID` (Maxina). Behaviour is dark by default: with the flag off, the fleet is byte-for-byte what runs
today.

## Requirements (EARS)

### R1 — Flag gate (lane `jobs-tenant-loop`)
1. WHEN `MT_RESOLUTION_V2` is unset OR `tenant_settings.feature_flags.mt.jobs_tenant_loop` is absent THE SYSTEM
   SHALL resolve a single tenant from `DEFAULT_TENANT_ID`, exactly as today.
2. WHEN both are set THE SYSTEM SHALL iterate the active-tenant set.

### R2 — Active-tenant loop (lane `jobs-tenant-loop`)
1. THE SYSTEM SHALL expose `activeTenantIds(sb)` = `tenants WHERE is_active AND NOT is_platform`.
2. THE SYSTEM SHALL expose `tenantTimezone(sb, tenantId)` reading `tenant_settings.timezone`, falling back to
   `Europe/Berlin` when absent or invalid.
3. THE autopilot heartbeat loop (`index.ts`) and every `scheduled-notifications.ts` route SHALL run once per active
   tenant when the flag is on, each with its own tenant context and timezone; the existing per-user
   `getUserTimezone` resolution SHALL be unchanged.

### R3 — Automation actor tenant (lane `jobs-automation-actor-tenant`)
1. WHEN the flag is on, every automation event dispatched from a member route SHALL carry the actor's real tenant,
   never `DEFAULT_TENANT_ID`; the fallback SHALL be `resolvePrimaryTenant` (or the primary `user_tenants` row until
   WS1 ships), never Maxina.

### R4 — Community scan & memory backfill per tenant (lane `jobs-community-scan-tenant`)
1. WHEN the flag is on, `runCommunityScan` and the hourly `/community-scan` tick SHALL loop active tenants, scanning
   each tenant's members with that tenant's timezone.
2. WHEN the flag is on, the memory-embedding backfill loop SHALL take its tenant set from `activeTenantIds(sb)`;
   `MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` SHALL remain the override for the off/pinned path.

### R5 — EventBridge schedules tenant-less (lane `jobs-env-prepare`, executor claude)
1. THE EventBridge schedules and `setup-eventbridge-*.sh` scripts SHALL stop pinning a single `TENANT_ID` in the
   target input; the gateway SHALL resolve the active-tenant set itself.

## Not in this slice
`DEFAULT_TENANT_ID` removal from the codebase (M2 cleanup); the resolution chain / access-token hook / `TenantContext`
(WS1); community-table RLS/scope (WS3); tenant-owner analytics and the launch content pipeline (WS8). Each later
slice is sparred on its own.
