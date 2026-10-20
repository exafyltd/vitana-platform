---
slug: plan-spar-stale-session
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: approved
updated: 2026-10-20T10:13Z
sparring_record: .kiro/specs/plan-spar-stale-session/sparring/verdict.md
vtids: [VTID-05254]
---
# Handoff — plan-spar-stale-session
Planner: Kiro seat `hotmail` (session kiro-hotmail-202610151618-b437). Plan: `plan.md` (between the plan
markers), sparred by PLAN-SPAR. `requirements.md`, `design.md` and `tasks.md` carry the detail.

Lanes (held at `ready` until PLAN-SPAR allocates each lane's VTID):
- `stale-session-dedup`: kiro, seat hotmail, reviewer exafyltd, repo vitana-platform. Create dedup re-runs a
  dead round-1 `in_progress` session (`escalated` / `deadline_exceeded`) instead of returning it forever.

## Log
### 2026-10-20T10:00Z · kiro-hotmail-202610151618-b437 · created → drafted
Plan drafted from a read-only diagnosis of five stuck PLAN-SPAR sessions (`in_progress`, 0 rounds,
`updated_at` = creation): mt-tenant-admin `16789ea0-ccfd-4c04-b25c-828f204e3c1a`, mt-packs
`bf74db47-7a95-47f4-bbe1-74eed286a52f`, mt-jobs `60ea1408-6953-4519-9674-73e5c6aa6da2`, mt-launch
`b160433a-bf5f-40d0-ade5-8495305e8f5b`, mt-discover `da362c5a-6f93-4756-a159-42d2372a4754`.
Premises are checked against `origin/main` @ `26aab2dc5` (file:line in `plan.md`). The rounds endpoint needs no
change: a dead round-n pass is re-run by the next push (plan premise 5).

**For Claude Code:** once this lane is merged and staging (the default PLAN-SPAR gateway, `PLAN-SPAR.yml:75`)
runs it, the five specs recover on their next push with no data change. Until then Claude Code may
terminalize the five rows (`escalated`, `deadline_exceeded`) if they are in the way. That is a live write, and
Kiro does not do it. Overlap: `sparring-floor-retry/floor-retry-code` (VTID-05240) edits the same `retryable`
expression (`plan-sparring-service.ts:250-251`). Whichever merges second rebases and keeps both.

### 2026-10-20T10:13Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
