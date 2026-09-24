# VTID-04465 — Operator pipeline regression suite

One test file that runs the real Operator Console → Dev Autopilot pipeline end
to end, so a change that breaks how an operator request becomes a shipped
change fails CI.

## What it is

`services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts` runs
the **real code of every stage**, in order, over one in-memory database and one
in-memory GitHub (`services/gateway/test/operator-pipeline/fake-operator-platform.ts`,
which extends the support suite's `FakePlatform` with the PostgREST features the
Dev Autopilot code uses: JSON-path filters, `not.in`, multi-column order,
upserts, DELETE, the `allocate_global_vtid` RPC and the one-in-flight-execution
unique index):

console turn (`POST /api/v1/operator/chat`, real `optionalAuth` + machine auth)
→ VTID-03851 gate → `autopilot_run_task` → on-ramp (VTID allocated and
registered, finding, plan, execution `cooling`) → `backgroundExecutorTick`
(claim, env + executor stamp) → the real `runAgentExecutionSession` /
`runAgentLoop` / agent tools on a temp-dir clone → PR contract → approval hold
→ `autopilot_approve_execution` → PR opened → `ciWatcherTick` → merge →
`deployWatcherTick` (`staging.deploy.completed`) → `verificationWatcherTick` →
ledger terminalized.

Stubbed edges (reasons in `services/gateway/test/operator-pipeline/harness.ts`):
the LLM (`callViaRouter`, a scripted DeepSeek-style model), git clone/push (a
temp directory seeded from the fake GitHub; the agent's real tools edit it),
tsc/jest inside the clone, the agent memory pack, the self-healing triage agent,
dev_agent_memory embeddings, and `VITANA_ENV` (a getter). No network call can
leave the test: the suite's fetch refuses everything that is not the fake
database or the fake GitHub, and every test asserts none was attempted.

## Acceptance criteria

AC-1: Golden path. A machine-authenticated console turn whose model calls `autopilot_run_task` allocates a VTID through `allocate_global_vtid` and registers it `in_progress`/`approved`; creates the `operator_onramp` finding, plan v1 and a `cooling` execution pinned to the agent executor with the DeepSeek override and `require_approval`; the tick claims it for `staging`; the agent (worker stage, DeepSeek Flash override) reads, edits, adds a test, checks and finishes; the runner re-runs tsc and jest; the PR contract puts `(VTID-…)` in the title and `VTID:` / `VALIDATION_PROFILE:` in the body plus the evidence pack; the run holds as `awaiting_approval` with no PR; the console approve opens exactly one PR; CI pending waits, CI green merges and stamps `merge_sha`; the staging deploy event moves it to `verifying`; the elapsed window completes it; the ledger is `is_terminal`/`success`/`completed`, the finding `completed`, and the OASIS events appear in pipeline order.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-2: Only a verified exafy_admin (or the machine credential) can queue work. Anonymous, non-admin JWT (`autopilot_run_task` and `autopilot_execute_task`), an anonymous request reusing an admin's thread, and a wrong machine token are refused before any VTID, finding or execution exists, with `autopilot.intent.rejected` carrying the reason; an admin JWT queues normally.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-3: Provider outage. Both providers failing on the first LLM call fails the execution with the outage error and nothing is pushed; after one outage failure the next tick claims at most one execution (probe); after three the next ticks claim nothing, no worker call is made, and `dev_autopilot.provider_outage.detected` is emitted.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-4: Turn cap. An auto-approved finding whose agent only reads until the 8-turn cap fails with `agent hit the 8-turn cap`; the next auto-approve pass snoozes the finding 7 days (`dev_autopilot.finding.snoozed`, reason `turn_cap_failure`) instead of approving a second execution.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-5: CI failure on an agent PR. The PR stays open, the self-heal child carries `fix_mode` (same branch/PR) and the failing job's log excerpt, the PR-flood guard admits it, the fix run clones the PR branch and pushes a fast-forward to it, exactly one PR exists, green CI merges it, and the parent lineage closes `self_healed`.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-6: Environment ownership. Staging's CI watcher and running-watchdog ignore rows production claimed; production merges its own; a legacy unstamped row is visible to both; the watchdog reclaim merges metadata.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-7: Cancel. A console `autopilot_cancel_execution` during a run cancels the row; the agent stops at its next boundary via the heartbeat read-back; nothing is pushed, no PR, no self-heal child, no triage; the ledger closes `cancelled`.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-8: A single-shot PR that fails CI is closed by the bridge, which stamps `pr_closed_unmerged_at`; the retry then runs and opens a new PR. Control: with the stamp removed, the same PR-flood guard refuses the retry.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-9: An armed kill switch stops the executor tick from claiming and the CI watcher from merging.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-10: The emulated one-in-flight-execution index covers exactly the statuses the migration defines, so the fake cannot drift from the database silently.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Evidence that the suite catches breakage

`outputs/mutation-run.txt`: eight mutants, each the suite plus one `jest.mock`
that breaks one real module (env ownership, the auth predicate, the retry
breaker, the outage slot gate, the stranded-PR filter, the PR contract, the
approval hold, fix-mode parsing). Every mutant failed at least one test. The
mutant files were generated in `test/operator-pipeline/__mutants__/`, run and
deleted; no source file was edited.

## Known bug pinned (not fixed here)

A fix-mode lineage's VTID is terminalized `failed` at the parent's first red CI
and stays failed when the fix-mode child merges and completes.
`dev-autopilot-watcher.ts` moves the parent `ci → failed` through
`transitionStatus()`, which calls `applyExecTerminalSideEffects(…, 'failed')`
→ `terminalizeVtidLedgerForExecution(…, 'failed')` before the bridge relabels
the row `reverted`; the child's `completed` cannot reopen it (the ledger PATCH
is guarded by `is_terminal=eq.false`). Pinned as an `it.failing` test that
asserts the correct outcome; `outputs/known-bug-ledger.txt` shows it fails only
on its final ledger assertion.

## Not covered

Real git, tsc and jest inside the clone; the ECS job dispatch path
(`DEV_AUTOPILOT_USE_JOB`); the LLM merge review; the self-healing triage agent
itself; the SSE `/chat/stream` route; production promotion.
