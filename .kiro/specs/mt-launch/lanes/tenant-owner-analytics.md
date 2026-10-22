---
lane: tenant-owner-analytics
state: ready
next_actor: kiro
depends_on: [pack-intake-db, pack-intake-admin]
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/routes/tenant-admin/owner-analytics.ts
  - services/gateway/src/routes/tenant-admin/owner-analytics-repository.ts
  - services/gateway/src/index.ts
  - services/gateway/test/mt-launch-owner-analytics.test.ts
  - services/gateway/test/mt-launch-owner-analytics-health-boundary.test.ts
  - docs/validation/VTID-mt-launch-owner-analytics/**
updated: 2026-10-21T13:58Z
vtid: VTID-05326
---
# tenant-owner-analytics — tenant-owner funnel + D18 lineage guard (repo vitana-platform)

Plan: `../plan.md` (authoritative) and the `tenant-owner-analytics` section of `../tasks.md` (tasks P1–P3, allowed
paths, acceptance). Design + successor rules: `../design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR converges and allocates this lane's VTID; it then flips to `kiro`.
Depends on `pack-intake-db` (reads `get_tenant_launch_readiness`) and `pack-intake-admin` (imports its per-tenant
dark-flag resolver `services/gateway/src/services/tenant-launch/tenant-feature-flag.ts`, imported read-only — no path entry needed). Reads
`product_analytics_events`/rollups only; tenant-scoped via `requireTenantAdmin` + the tenant path segment, never a
body/header tenant. Dark behind `isTenantFeatureLive(tenantId, 'mt.launch_analytics')` — NOT `isFeatureLive`
(`feature-flags.ts:81`), which is single-arg/global and cannot express a per-tenant flag.

**D18 is the point of this lane:** no owner-analytics module may read a health table; unknown-provenance tables count as
health (deny-by-default). The build-failing guard `mt-launch-owner-analytics-health-boundary.test.ts` copies
`test/vtid-05025-commerce-health-boundary.test.ts`, lists the owner-analytics source files, uses an explicit read
allowlist (`product_analytics_events`, `product_analytics_daily_rollups`, `tenant_pack_intake`, `tenant_content_pipeline`, `tenants`, RPC `get_tenant_launch_readiness`; any other `.from`/`.rpc` name fails), an inline `HEALTH_TABLES` deny regex (moved to
mt-identity's `isHealthTable()`, O1, once it ships), and self-tests a planted read.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`/another lane,
no merge/approve/deploy/workflow dispatch, no Supabase or AWS write, never call a live system. Work only inside the
allowed paths. Add `docs/validation/VTID-mt-launch-owner-analytics/` (scope.json, staging-tests.json, plan copy).

Branch `kiro/mt-launch/tenant-owner-analytics`; PR title `VTID-xxxxx (mt-launch/tenant-owner-analytics): …`; commit
trailers `Collab-Session: <your kiro session id>` and `Collab-Lane: mt-launch/tenant-owner-analytics`. When the PR is
open: set `state: in-review`, `next_actor: kiro` (reviewer seat `exafy`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Five owner-analytics read endpoints + the fail-closed D18 health-boundary guard. seat `jtadic`
(gateway), reviewer `exafy`.

### 2026-10-20T19:00Z · kiro-hotmail-202610151618-b437 · spar session 2 round 1 (0de6a378) — no path change
R1-F1 full resolver path; R1-F2 explicit read allowlist enumerated.

### 2026-10-21T13:58Z · ci-plan-spar · ready (VTID allocated)
VTID-05326 allocated after policy approval (converged-auto-v1).
