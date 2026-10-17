---
lane: jobs-env-prepare
state: ready
next_actor: claude
depends_on: []
executor: claude
reviewer_seat: jtadic
paths:
  - scripts/aws/setup-eventbridge-whats-new.sh
  - scripts/aws/setup-eventbridge-push-dispatch.sh
  - scripts/aws/setup-eventbridge-daily-feature-tip.sh
  - scripts/aws/setup-eventbridge-cron-migration.sh
  - docs/validation/
updated: 2026-10-15T16:40Z
---
# jobs-env-prepare — EventBridge schedules stop pinning one tenant (repo vitana-platform)

Plan: `.kiro/specs/mt-jobs/plan.md` (authoritative) and the `jobs-env-prepare` section of `tasks.md` (E1–E3,
allowed paths, acceptance). Design: `design.md`.

Executor **claude**: these are AWS/EventBridge governance paths. The gateway stops receiving a pinned tenant in the
schedule body; `jobs-tenant-loop` resolves the active-tenant set. Applied against the AWS estate by Claude/owner —
a Kiro session never makes a mutating AWS call.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve, no deploy
beyond the governed AWS apply, no live write outside the approved EventBridge change. Work only inside the allowed
paths. Branch `claude/mt-jobs/jobs-env-prepare`; PR title `VTID-xxxxx (mt-jobs/jobs-env-prepare): …`; commit trailers
`Collab-Session: <session id>` and `Collab-Lane: mt-jobs/jobs-env-prepare`.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Governance/EventBridge lane → executor claude, `next_actor: claude` (Claude builds these, not owner-held). VTID
allocated by PLAN-SPAR after convergence.
