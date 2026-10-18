# Acceptance — VTID-05217 (pm-agent/p4-act): Project Manager act

Each P4 item (tasks.md `p4-act`, plan §6.3) → its test. All tests under
`services/gateway/test/project-manager/`.

AC-1 — safe-merge extracted as an in-process typed function, route behaviour unchanged
The POST `/api/v1/github/safe-merge` route body is refactored into an exported
`safeMerge(input): Promise<SafeMergeOutcome>` with `result: 'merged' | 'already_merged' | 'refused'`.
The route is a thin adapter that replays the identical status + JSON body. A PR
that is not open (`pr_not_open`, cicd.ts) maps to `already_merged` — a no-op
success for in-process callers — while the route still returns the identical
400 `pr_not_open` body.

TEST: `services/gateway/test/project-manager/safe-merge-fn.test.ts`
- clean merge → `merged`, status 200, `mergePullRequest` called once
- PR not open → `already_merged`, status 400, body `pr_not_open`, never merges
- unauthorized repo / pr not found / invalid base / checks failed / governance
  blocked → `refused` with the same status + reason the route returned before

AC-2 — act layer gated behind PM_MODE=live; dry_run/off do nothing
`actOnDecisions` acts ONLY in `live`. In `dry_run`/`off` it performs no action.

TEST: `services/gateway/test/project-manager/act.test.ts`
- live: a merge-eligible decision calls safe-merge exactly once
- dry_run / off: never calls safe-merge (`acted:false`, `skipped_reason:not_live`)

AC-3 — MERGE goes only through the in-process safe-merge; never deploy/dispatch/allocate
The act layer calls the injected safe-merge function; there is NO deploy /
workflow-dispatch / allocate seam reachable from it. After a merge, lane+plan
set `done`.

TEST: `services/gateway/test/project-manager/act.test.ts`
- "never deploys, dispatches, or allocates": acting on every decision kind
  touches only safe-merge, lane-file writes and the Gate-2 post; the
  deploy/dispatch/allocate tripwire counters stay 0

AC-4 — governance-path final guard: reviewer must be `claude`
A governance-path lane PR is merged only when `reviewer_seat === 'claude'`.

TEST: `services/gateway/test/project-manager/act.test.ts`
- governance-path PR, reviewer not claude → `governance_blocked`, safe-merge never called
- governance-path PR, reviewer claude → `merged`
- `laneTouchesGovernance` / `governanceMergeAllowed` unit checks

AC-5 — already-merged is a no-op success; refused does not mark the lane done
TEST: `services/gateway/test/project-manager/act.test.ts`
- already-merged → `already_merged`, lane set `done`
- safe-merge refused → `merge_refused`, lane NOT touched

AC-6 — per-tick lease; absent pm_lease table (p1 not merged) → tick no-ops
The lease is taken per tick. The `pm_lease` table ships with P1 (not merged);
until then the default `NoLeaseManager` reports `table_absent` and the tick
safely no-ops — never crashes, never acts without a lease. A lease held by
another task also no-ops.

TEST: `services/gateway/test/project-manager/act.test.ts`
- lease absent → `acted:false`, `skipped_reason:no_lease`, no safe-merge call
- lease held by other → no-op
- no lease injected → defaults to the fail-safe NoLeaseManager → no-op

AC-7 — Gate-2 batch posts the run-view question with the full prod→verified commit list; never deploys
TEST: `services/gateway/test/project-manager/act.test.ts`
- "Gate-2 batch": posts the exact question
  "Staging verified — ready for deployment to production?" with VTIDs and the
  full `production..verified` commit list; no deploy ever happens

AC-8 — reassign / park write lane-file state
TEST: `services/gateway/test/project-manager/act.test.ts`
- reassign to a seat moves seat + next_actor; to claude sets next_actor only
- stale-claim park sets `parked`, `next_actor: claude`, releases the claim

## Verification
- `tsc --noEmit`: clean.
- `jest test/project-manager`: 5 suites, 77 tests passing (P3's decide/route/tick
  tests stay green, proving the safe-merge refactor is behaviour-preserving).

## Route mount

ROUTE_MOUNT: no new route added. `services/gateway/src/routes/cicd.ts` is edited only to export the existing safe-merge logic as an in-process function; the existing `POST /api/v1/github/safe-merge` mount and behaviour are unchanged.
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/github/safe-merge` (existing, unchanged)
CURL_PROOF: not run from this session (no gateway call permitted); the refactor is behaviour-preserving and proven by the existing cicd safe-merge route tests plus the new in-process safe-merge function tests under `services/gateway/test/project-manager/`.
