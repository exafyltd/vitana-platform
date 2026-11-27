---
change_class: standard
---
# plan(kiro-session-monitor): one read-only monitor for every Kiro session, and the acceptance suite for parallel execution, persistence, idempotency and recovery
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611270941-776e` (Kiro Web). Repo: `exafyltd/vitana-platform`.
Premises pinned to vitana-platform `origin/main` `ae8548b858`. Detail per lane: `tasks.md`; lane files:
`lanes/monitor-core.md`, `lanes/dispatch-acceptance.md`.
<!-- plan:begin -->
## 1. Goal
Owner task, 2026-11-27 (Kiro Web), P0: *"Dispatcher monitoring and recovery. Inspect existing Worker Orchestrator,
Agent Registry, VTID, OASIS and execution coordination infrastructure. Prepare centralized monitoring of Kiro
sessions. Cover heartbeat, progress, failure, recovery and completion. Reuse existing infrastructure. No duplicate
orchestration. Prepare acceptance tests for parallel execution, session persistence, idempotency and recovery.
Implement missing independent components."*

## 2. Today (what exists; nothing here is rebuilt)
| Concern | Existing code | Covers |
|---|---|---|
| Operator Kiro run liveness | `services/gateway/src/services/kiro/kiro-runs.ts`: heartbeat tick every 30 s (`KIRO_RUN_LIMITS.heartbeatMs`, :81, tick :755), stale sweep every 60 s marks another task's run `interrupted` after 120 s (`staleMs` :83, sweep :792), OASIS `operator.kiro.run_started/run_finished/run_interrupted/run_reattached` (`types/cicd.ts:1208`) | heartbeat, failure, completion of operator runs |
| Persistence and recovery of a run | `kiro_runs` + `kiro_run_events` (migration `20261010210000`), reattach identity (`20261010220000`, `kiro-reattach-token.ts`, `reattachOrphanedKiroRuns` called at `kiro-runs.ts:795`), SSE replay by `seq` (`followKiroRun` :702) | session persistence, recovery |
| Autonomous task claims | `routes/worker-orchestrator.ts`: claim/release/heartbeat/expire (`:1250`, `:1335`, `:1450`, `:1717`); eligibility = autonomous plane only (CLAUDE.md §4 criterion 5) | VTID claims for workers |
| Agent catalogue | `routes/agents-registry.ts` | agent registry (read) |
| Plan driver and lane liveness | git refs `collab-driver/<slug>` (alive < 45 min, `plan-driver.mjs`, `project-manager/types.ts:394`) and `collab-claim/<slug>/<lane>`; PM reader `GithubRestReader.refDate` (`observe-live.ts:716`); PM reassign/stale-claim windows (`types.ts:383-390`) | cloud/Web session liveness |
| Retry with backoff | lanes `dispatcher` (VTID-05737, in review, PR #5125) and `dispatcher-pm` (VTID-05736) of plan `agentic-delivery-scope` | recovery scheduling for parked lanes |
| Heartbeat cadence of drivers | lane `heartbeat-30` (VTID-05739) of the same plan | driver heartbeat interval |

## 3. Gaps verified in the code
1. **Heartbeat is not progress.** `kiroRunsHeartbeatTick` refreshes `last_heartbeat_at` for every unfinished run of the
   gateway task (`kiro-runs.ts:755-758`). A Kiro turn that stops producing events while its gateway task lives keeps a
   fresh heartbeat until the 15 min prompt timeout (`acp-client.ts:120`). A run in `waiting_permission` has no limit.
   Nothing reports "alive but not progressing".
2. **No single view.** Operator runs (`kiro_runs`), plan drivers (heartbeat refs) and lane claims (claim refs) are read
   by three separate code paths. No place answers "which Kiro sessions exist, in what state, and what recovers each".
3. **Parallelism invariants are enforced in many places and observed in none.** One running run per thread, at most 6
   build lanes per plan (`MAX_BUILD_LANES_PER_PLAN`, `types.ts:400`), one driver per plan, no parallel execution of one
   VTID (CLAUDE.md NEVER 15). A violation is only found by reading the rows.
4. **No composed acceptance test.** `vtid-05065-kiro-runs.test.ts` and `vtid-05068-kiro-run-reattach.test.ts` pin the
   parts; `vtid-04465-operator-pipeline-regression.test.ts` covers the operator turn. No test states, in one place,
   the four properties the owner named across both session kinds.

## 4. Change — two lanes
### Lane `monitor-core` (new independent component, read-only)
New `services/gateway/src/services/kiro/session-monitor.ts`, route `services/gateway/src/routes/operator-kiro-monitor.ts`
mounted at `GET /api/v1/operator/kiro/monitor` (admin auth). It is registered with
`mountRouterSync(app, '/api/v1/operator/kiro/monitor', router, { owner: 'operator-kiro-monitor' })` beside the
`operator-kiro-runs` mount (`index.ts:896`), so the route guard (VTID-01063, `index.ts:64`) covers it with its
duplicate-route check and startup summary; never a bare `app.use()` (R1-F2).
- **Pure core** `classifySession(snapshot, now, limits)` returning
  `{ state, reason, recommended_action }`:
  - states: `queued`, `healthy`, `no_progress` (heartbeat fresh, newest event older than `noProgressMs`),
    `permission_overdue`, `heartbeat_lost`, `recoverable` (heartbeat lost, reattach window open), `failed`,
    `interrupted`, `completed`, `cancelled`.
  - `recommended_action` names an existing mechanism and never performs it: `wait`, `reattach` (existing
    `reattachOrphanedKiroRuns`), `sweep` (existing `sweepStaleKiroRuns`), `pm_retry` (lane `dispatcher-pm`),
    `pm_reassign` (existing PM rule), `owner` (the retry cap is exhausted or the reason is non-retryable).
  - thresholds are imported, not redefined: `KIRO_RUN_LIMITS.staleMs`, `KIRO_PROMPT_TIMEOUT_MS`, `DRIVER_ALIVE_MS`,
    `MAX_BUILD_LANES_PER_PLAN`; `noProgressMs` defaults to `KIRO_PROMPT_TIMEOUT_MS`.
- **Pure** `findViolations(snapshots)`: two running runs on one thread; more than 6 `executing|in-review` lanes in one
  plan; two live drivers for one slug; two active sessions for one VTID.
- **Readers (injected, read-only):** operator runs from `kiro_runs` plus the newest `kiro_run_events.created_at` per run
  (one query, `order=created_at.desc`, limited); driver and claim ages through the existing `refDate` method of `GithubReader`
  (declared at `observe-live.ts:81`, implemented by `GithubRestReader` at `:716`). The monitor types its reader as
  `Pick<GithubReader, 'refDate'>`, so tests inject a one-method fake and `observe-live.ts` stays unchanged (R1-F1). No new table, no migration, no write, no new OASIS event type: heartbeats are never OASIS
  events (CLAUDE.md NEVER 10), and every transition that matters already emits its event in `kiro-runs.ts`.
- **Response** `{ generated_at, counts_by_state, sessions[], violations[] }`; ids and states only, never the run
  message, reply or any token. A source that fails to read is reported as `sources[].ok=false`, never as healthy.
### Lane `dispatch-acceptance` (test only, depends on `monitor-core`)
One suite `services/gateway/test/kiro-dispatch-acceptance.test.ts`, run over the real `kiro-runs.ts` with an in-memory
database in the style of `vtid-04465-operator-pipeline-regression.test.ts`, plus the real classifier:
- **A. Parallel execution:** runs on different threads execute at the same time; a second run on one thread queues
  (third queues, fourth → `queue_full`); the monitor reports the violations of §4 on crafted rows and none on a
  valid set; 6 lanes ok, a 7th is a violation.
- **B. Session persistence:** a run survives a restart of the reader (rows + events replay in `seq` order, no event
  lost or repeated after `after_seq`); the reattach identity stores a hash, never the token.
- **C. Idempotency:** two sweeps in a row change nothing the second time; a second cancel and a second complete are
  no-ops; the monitor is a pure read (two calls, same input → same output, zero writes).
- **D. Recovery:** a run whose task vanished inside the window is classified `recoverable` → `reattach`; after the
  window → `interrupted` → `sweep`; a retryable failure → `pm_retry`; an exhausted or non-retryable one → `owner`;
  `no_progress` and `permission_overdue` are reported while the heartbeat stays fresh.

## 5. Tests (written first, recorded red on `origin/main`)
`monitor-core`: `services/gateway/test/kiro-session-monitor.test.ts`, red on base because the module does not exist.
`dispatch-acceptance`: the suite above; section A, B, C and the sweep/cancel parts of D exercise existing code and
must be green on base. Only the classifier-dependent cases are red on base until `monitor-core` is merged, which is
why the lane depends on it. Commands: `npx jest test/kiro-session-monitor.test.ts test/kiro-dispatch-acceptance.test.ts`,
`npm run typecheck`, `npm run test:operator`, and `npx jest test/vtid-05065-kiro-runs.test.ts test/vtid-05068-kiro-run-reattach.test.ts`.
CLAUDE.md 42e applies (operator pipeline): `test:operator` must stay green and the new behaviour is added as a scenario
to the acceptance suite.

## 6. Staging proof
The route deploys. `docs/validation/<VTID>/staging-tests.json` holds read-only probes: unauthenticated
`GET /api/v1/operator/kiro/monitor` answers 401 JSON (route is live, auth gate holds). No authenticated call, no write.

## 7. Unchanged
`kiro-runs.ts`, `kiro-turn.ts`, `worker-orchestrator.ts`, `agents-registry.ts`, the Project Manager, `plan-driver.mjs`,
migrations, `DATABASE_SCHEMA.md`, OASIS event types, the lanes of plan `agentic-delivery-scope`, CLAUDE.md and all
protected gate files. No retry logic is added: `pm_retry` only points at lane `dispatcher-pm`.

## 8. Risks
- A `no_progress` threshold equal to the prompt timeout may report a slow but healthy turn late; it is a report, not
  an action. Configurable through `KIRO_MONITOR_NO_PROGRESS_MS`.
- GitHub rate limits on `refDate`: the reader is bounded (plans in the queue only, concurrency 4) and a failure marks the
  source `ok=false`.
- `dispatcher-pm` is not merged yet: `pm_retry` is a label until it lands; the acceptance case pins the label, not the PM.
<!-- plan:end -->
