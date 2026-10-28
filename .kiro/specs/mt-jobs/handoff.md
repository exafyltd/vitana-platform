---
slug: mt-jobs
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: approved
updated: 2026-10-20T17:43Z
sparring_record: .kiro/specs/mt-jobs/sparring/verdict.md
vtids: [VTID-05267, VTID-05268, VTID-05269, VTID-05270]
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

### 2026-10-17T14:26Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:32Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T16:30Z · kiro-hotmail-202610151618-b437 · replan → re-spar (round 1 escalated: evidence_floor_not_met)
Round 1 escalated `evidence_floor_not_met` (0 premise checks on the partner side) plus two prior `partner unavailable`
escalations — no plan finding to answer. Re-verified all seven premises against tip `41482d7` today and corrected the
drifted file:line citations in `plan.md` / `tasks.md`: heartbeat `index.ts:1840`→`:1844` (assignment) + call
`:1849`→`:1853`, block `1838-1866`→`1842-1866`; `getTenantId` def `scheduled-notifications.ts:105`→`:104`;
`/night-push` `getTenantId(req)` `:1527`→`:1526`; memory backfill `memory-embedding-backfill-loop.ts:38-44`→`:38-43`.
Verified unchanged and exact: the seven automation-event sites (`community.ts:274,382,482`, `match-feedback.ts:280`,
`matchmaking.ts:576`, `admin-signups.ts:205`, `groups-events-tools.ts:360`), community-scan route `:2281`/`:2294`,
`scan-runner.ts:255`, `getUserTimezone` `:1567`. Response recorded in `sparring/responses-1.md`. Re-pushed to re-spar.

### 2026-10-18T20:09Z u{00B7} kiro-hotmail-202610151618-b437 u{00B7} re-spar round (session 5871c575 round 1, in_progress)
Answered all five s2-round-1 findings in `sparring/s2-responses-1.md` and updated `plan.md` + `tasks.md` + the four lane files (paths unchanged). R1-F1 accepted: the EventBridge tenant pin is NOT a schedule target input -- whats-new.sh/daily-feature-tip.sh pin it in the Lambda --environment Variables (whats-new.sh:204,218) + inline handler body (whats-new.sh:158, daily-feature-tip.sh:190), cron-migration.sh in the schedule Input body of ~26 jobs (:156-188), push-dispatch.sh pins none; Problem 7 + lane 1 + E1 reworded per mechanism. R1-F2 rejected: morning-brief-scheduler.ts exists at services/gateway/src/services/guide/ (partner missed the guide/ subpath) -- re-verified it fetches per-user tenant_id at :130-131 and passes it at :140/:152; added the full path to the plan. R1-F3 accepted: groups-events-tools.ts:357-360 is a fallback (id.tenant_id || DEFAULT_TENANT_ID), not a direct pin -- split into six pins + one fallback, annotated, dedicated no-regression test (A2). R1-F4 accepted: the /community-scan route emits one OASIS event per call (:2299-2309) -> emit ONE aggregated event after the per-tenant loop (C1/C3). R1-F5 accepted: the heartbeat setInterval is registered once at startup (index.ts:1848) -> flag + activeTenantIds evaluated inside each tick, mid-flight-toggle test added (L3/L5). Also re-anchored the plan verification line to tip `d4bc696` and fixed setInterval :1850->:1848. Pushed to start the next round.

### 2026-10-18T20:14Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:22Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:25Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:30Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:31Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:36Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-20T17:43Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 4 lane(s) got a VTID and are handed to Kiro.
