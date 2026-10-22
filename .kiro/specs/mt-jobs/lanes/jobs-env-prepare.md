---
lane: jobs-env-prepare
state: ready
next_actor: kiro
depends_on: []
executor: claude
reviewer_seat: jtadic
paths:
  - scripts/aws/setup-eventbridge-whats-new.sh
  - scripts/aws/setup-eventbridge-push-dispatch.sh
  - scripts/aws/setup-eventbridge-daily-feature-tip.sh
  - scripts/aws/setup-eventbridge-cron-migration.sh
  - docs/validation/
updated: 2026-10-22T22:10Z
vtid: VTID-05269
seat: exafyltd
---
# jobs-env-prepare — EventBridge schedules stop pinning one tenant (repo vitana-platform)

Plan: `.kiro/specs/mt-jobs/plan.md` (authoritative) and the `jobs-env-prepare` section of `tasks.md` (E1–E3,
allowed paths, acceptance). Design: `design.md`.

Executor **claude**: these are AWS/EventBridge governance paths. The tenant is pinned by three mechanisms, none a
schedule "target input": `whats-new.sh`/`daily-feature-tip.sh` via the Lambda `--environment Variables` + inline
handler body (`JSON.stringify({ tenant_id: … })`), and `cron-migration.sh` via the schedule Input body of ~26 jobs;
`push-dispatch.sh` pins none. E1 removes each per its mechanism so the gateway (`jobs-tenant-loop`) resolves the
active-tenant set. Applied against the AWS estate by Claude/owner (both Lambda config AND code re-applied) — a Kiro
session never makes a mutating AWS call.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve, no deploy
beyond the governed AWS apply, no live write outside the approved EventBridge change. Work only inside the allowed
paths. Branch `claude/mt-jobs/jobs-env-prepare`; PR title `VTID-xxxxx (mt-jobs/jobs-env-prepare): …`; commit trailers
`Collab-Session: <session id>` and `Collab-Lane: mt-jobs/jobs-env-prepare`.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Governance/EventBridge lane → executor claude, `next_actor: claude` (Claude builds these, not owner-held). VTID
allocated by PLAN-SPAR after convergence.
### 2026-10-18T20:07Z u{00B7} kiro-hotmail-202610151618-b437 u{00B7} re-spar round (s2-round-1 R1-F1)
Reworded E1/body: the tenant is NOT in a schedule target input. whats-new.sh/daily-feature-tip.sh pin it in the Lambda --environment Variables (whats-new.sh:204,218) + inline handler body (whats-new.sh:158, daily-feature-tip.sh:190); cron-migration.sh bakes it into the schedule Input body of ~26 jobs (:156-188); push-dispatch.sh pins none. Paths unchanged.

### 2026-10-20T17:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05269 allocated after policy approval (converged-auto-v1).
### 2026-10-22T19:06Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:10Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:14Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:18Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:22Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:26Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:30Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:34Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:38Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T19:42Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:06Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:10Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:14Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:18Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:22Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:26Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:30Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:34Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T20:38Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T21:26Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T21:30Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T21:34Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T21:38Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T22:06Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
### 2026-10-22T22:10Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
