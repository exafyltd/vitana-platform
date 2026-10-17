---
slug: mt-jobs
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-10-15T16:40Z
---
# Handoff — mt-jobs (WS6: jobs & events loop over active tenants)

Program `docs/MULTI-TENANT-PLAN.md` §6 (WS6). Planner: Kiro seat `hotmail`
(session `kiro-hotmail-202610151618-b437`). Plan: `plan.md` (what PLAN-SPAR spars). Requirements, design and
successor rules: `requirements.md`, `design.md`. Tasks: `tasks.md`.

Scheduled jobs and automation events iterate active tenants with each tenant's timezone instead of a single
`DEFAULT_TENANT_ID`, dark behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.jobs_tenant_loop`. No
migration — reads the applied M0 columns (`tenants.is_active/is_platform`, `tenant_settings.timezone`).

Lanes:
- `jobs-env-prepare` — executor **claude** (governance: EventBridge infra), repo vitana-platform, `ready`,
  `next_actor: claude`. EventBridge schedules stop pinning one tenant.
- `jobs-tenant-loop` — executor kiro (seat `jtadic`), repo vitana-platform, `ready`, held (`next_actor: owner`).
  Shared `mt-flags.ts` + `job-tenant-loop.ts`; heartbeat + scheduled-notifications loop. Gates mt-launch APIs + M2 flips.
- `jobs-automation-actor-tenant` — executor kiro (seat `jtadic`), `ready`, held. Depends on `jobs-tenant-loop`.
- `jobs-community-scan-tenant` — executor kiro (seat `jtadic`), `ready`, held. Depends on `jobs-tenant-loop`.

Lanes are held at `next_actor: owner` until PLAN-SPAR converges and allocates each lane's VTID; it flips a lane to
`next_actor: kiro` itself. `jobs-env-prepare` is `next_actor: claude` (Claude builds governance/EventBridge lanes).

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → drafted
Wrote the spec from `docs/MULTI-TENANT-PLAN.md` §6. Premises re-verified in code 2026-10-15 (file:line in `plan.md`
Problem 1-7): heartbeat `index.ts:1840`, scheduled-notifications `getTenantId` `:105` + `/night-push` `:1525`,
community-scan `autopilot-recommendations.ts:2281`/`scan-runner.ts:255`, morning-brief already per-user-tenant
`morning-brief-scheduler.ts:132`, memory backfill env list `memory-embedding-backfill-loop.ts:38-44`, seven
automation-event sites, EventBridge scripts `setup-eventbridge-*.sh`. Confirmed M0 columns applied (no migration
needed). Applied CROSS-SPEC-DECISIONS: lane-count merge (4 code lanes + 1 governance lane), DB/code split N/A (no DB
lane), governance paths → executor claude. Next: PLAN-SPAR spars this plan PR; on convergence it allocates one VTID
per lane and flips the kiro lanes to `next_actor: kiro`.
