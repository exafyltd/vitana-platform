---
lane: s-j-retire-function
state: ready
next_actor: owner
depends_on: [s-j-route-inventory]
executor: claude
reviewer_seat: jtadic
paths:
  - .github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml
  - docs/validation/**
updated: 2026-10-20T08:30:00Z
---
# s-j-retire-function — undeploy `linkedin-import` via the RETIRE workflow (repo vitana-v1)
Plan: `.kiro/specs/mt-track-s/plan.md` (authoritative, between the plan markers) and the `s-j-retire-function` section
of `tasks.md`.
**HELD.** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID on a converged plan. Do not add a `vtid` field
by hand.
Why a separate lane (s2 R2-F1): deleting the `linkedin-import` source in `s-j-route-inventory` does not undeploy it —
`supabase-functions-deploy.yml` never deletes removed folders. The only undeploy is the dispatch-only, `ALLOWLIST`-gated
`SUPABASE-FUNCTIONS-RETIRE.yml` (`:42-45`), which refuses any name still under `supabase/functions/` — hence
`depends_on: [s-j-route-inventory]`. Editing `.github/**` is a governance path (collaboration §3a), and dispatching a
workflow / writing live Supabase is never Kiro's (§7a), so `executor: claude`.
Work: (R1) one commit adding `linkedin-import` to `ALLOWLIST`, PR under this lane's VTID; (R2) after merge, dispatch the
workflow for `linkedin-import` and record the run link + its `Confirm` step (a read of the project function list) in
`docs/validation/<vtid>/`. Branch `claude/mt-track-s/s-j-retire-function`; commit trailer
`Collab-Lane: mt-track-s/s-j-retire-function`. S-J closes when this lane is `done`.
Escalation carry-over (owner approved escalated, 2026-10-20) — R3-F1, task R2' in `tasks.md`, replaces (R2) above.
Acceptance: the executor does R1 only and never dispatches a workflow (§7a covers Claude Code executing a lane);
after merge the Project Manager (or the owner) dispatches `SUPABASE-FUNCTIONS-RETIRE.yml` for `linkedin-import`;
the run link and `Confirm` output are recorded in `docs/validation/<vtid>/` by the Project Manager or by Claude Code
as a coordinator follow-up outside lane execution; S-J closes when that output shows `linkedin-import` absent.
## Log
### 2026-10-19T18:00:00Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created by the mt-track-s planner in answer to s2 round 2 R2-F1 (the retire follow-up needs its own VTID and an
`executor: claude` lane). Held at `next_actor: owner` pending PLAN-SPAR VTID allocation.
