# Acceptance — VTID-05216 (pm-agent/p3-observe-decide)

Project Manager **observe + decide** in `dry_run` only (plan `.kiro/specs/pm-agent/plan-sparring.md` §6,
phase P3). Deterministic — rules in code, no LLM decides. P3 performs **no act**: no GitHub write, no merge,
no deploy, no VTID allocation, no Supabase/AWS write. `live` act is P4.

One AC per plan P3 item → its test.

AC-1 — Two switches gate the PM (plan §6)
`PM_AGENT_ENABLED` (default off) and `PM_MODE=off|dry_run|live` (default `dry_run`) gate the loop; unknown
`PM_MODE` falls back to `dry_run`; the 10-minute tick interval is configurable.
TEST: `services/gateway/test/project-manager/tick-and-config.test.ts` → `describe('config switches')`.

AC-2 — OBSERVE is a typed, read-only seam with a stub (p1/p2 not merged)
Typed `ObservedState`/`ObservedLane`/`ObservedPr`/`ReviewEntry` interfaces model registry, both-repo
queue/lane state, open PRs with CI check conclusions + Lane scope + Collab handoff + the optional
"Claude Approvals" App check, review entries, STAGING-VERIFY and ledger inputs. P3 ships a `PmObserver`
interface + `StubObserver` (empty world) because the live sources depend on p1 (migration) and p2
(registry), which are not merged. No live reader and no `pm_lease` dependency in P3.
TEST: `services/gateway/src/services/project-manager/observe.ts` (interface + stub) exercised by
  `tick-and-config.test.ts` (`runDecideTick` with `StubObserver` → empty decisions, snapshot recorded).

AC-3 — DECIDE is pure and table-tested: MERGE rule (plan §6.2)
A lane PR is merge-eligible only when ALL hold: lane `verified`; last review entry from the lane's
`reviewer_seat`, on the PR's **current head sha**, verdict `approve`; all required checks green on that head
incl. Lane scope and Collab handoff; if a "Claude Approvals" App check run exists on the head it is `success`;
no merge conflict; `depends_on` lanes all `done`; PR title carries the lane VTID; lane declares `paths`; and
the residual self-review guard (review session id ≠ every executing-log session id). Mutation-verified: each
precondition individually false → no merge, plus the all-true case → merge-eligible.
TEST: `services/gateway/test/project-manager/decide.test.ts` →
  `describe('mergeDecision — all preconditions true')` + `describe('mergeDecision — each precondition
  individually false')`.

AC-4 — DECIDE: REASSIGN rule (plan §6.2)
A lane `ready` >24h whose seat ran no automation in the window → next seat for the area, else `claude`; the
same for a review waiting >24h.
TEST: `decide.test.ts` → `describe('reassignDecision')`.

AC-5 — DECIDE: PARK rules (plan §6.2)
A lane whose PR failed CI on 3 consecutive pushes; a lane flagged `risk:` by its reviewer; a claim >48h with
no branch activity (released).
TEST: `decide.test.ts` → `describe('parkDecision')`.

AC-6 — DECIDE: GATE-2 BATCH timing (plan §6.2)
For deploying lanes merged + passing STAGING-VERIFY without a Gate 2: send when every deploying lane of the
plan is verified on staging, OR 4h after the first, whichever first.
TEST: `decide.test.ts` → `describe('gate2Decisions — all-verified vs 4h-elapsed timing')`.

AC-7 — Decisions are reported as `pm.decision` only (dry_run), never acted on
`decide()` returns typed decisions with no side effects; `runDecideTick` observes → decides → reports through
an injectable emitter and records a snapshot. No merge/deploy/dispatch/allocate code exists in P3. Mode `off`
→ no decisions; park takes precedence over merge for a troubled lane.
TEST: `tick-and-config.test.ts` → `describe('runDecideTick')`; `decide.test.ts` →
  `describe('decide — orchestration + mode gating + precedence')`.

Note on `pm.decision` OASIS wiring: the OASIS event union `CicdEventType`
(`services/gateway/src/types/cicd.ts`) is a closed union and `pm.*` is not yet a member; that file is outside
this lane's path scope. P3 therefore reports decisions through a typed `PmDecisionEmitter` seam
(`LoggingDecisionEmitter` default) and the read route's decision list; registering the `pm.decision` topic
and swapping the emitter to `emitOasisEvent` is a one-line change in the lane that owns the union (P4/P7).

AC-8 — Read route (plan §6.3, test plan)
`GET /api/v1/project-manager/status` returns the mode and the current decision list; auth is the service token
or an exafy_admin JWT (`requireServiceOrAdmin`). Registered in `index.ts`. The 10-min `setInterval` is behind
`PM_AGENT_ENABLED` and is a no-op otherwise; it only ever calls decide+report, never act.
TEST: `services/gateway/test/project-manager/route.test.ts`.

## Local checks
- `npx tsc --noEmit` (gateway): PASS, 0 errors.
- `npx jest test/project-manager` (gateway): 3 suites, 52 tests, all PASS.

## Route mount

ROUTE_MOUNT: `services/gateway/src/routes/project-manager.ts` registered at `/api/v1/project-manager` in `services/gateway/src/index.ts`; GET `/status` returns the PM mode and current decision list (read-only).
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/project-manager/status` (staging)
CURL_PROOF: not run from this session (no gateway call permitted); the read route is proven by `services/gateway/test/project-manager/route.test.ts` and the staging probe in `staging-tests.json` (GET /api/v1/project-manager/status → 200). dry_run: the endpoint returns mode + decisions, performs no action.
