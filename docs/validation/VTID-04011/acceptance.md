# VTID-04011 — Running-watchdog reclaims live agent executions and clobbers row metadata (found by Test Run #4)

Context: Test Run #4 (VTID-04008, execution `47a4d6eb`, staging, ECS task `dabb2bb6` on `vitana-autopilot-executor:9`). Timeline from `oasis_events` / `dev_autopilot_executions`:

| UTC | What |
|---|---|
| 19:29:08 | row claimed (`metadata`: `executor:agent`, `claimed_env:staging`, `llm_on_ramp:deepseek`, `llm_on_ramp_override:{deepseek/deepseek-flash}`); `updated_at` set — and never touched again while the task ran |
| 19:29:36 – 19:53:46 | agent loop alive the whole time (44 turns; nine `run_check tsc` OOMs, VTID-04009) |
| 19:49:37 | `backgroundExecutorTick` step 0b: `status=running & updated_at < now-20m` → reclaimed as "stuck in 'running' > 20m (container recycled mid-execution)" while the task was alive; PATCH wrote `metadata: { error }` — every other key gone |
| 19:50:05 | self-heal child `8b2bce93` spawned; `inheritedOnRampMetadata(parent.metadata)` found no `executor`/override → child ran **single-shot** on Bedrock (PR #3379, incomplete, closed) |
| 19:53:47 | the still-running parent hit the agent deadline; `applyExecutionResult` failure path wrote `metadata: { error }` — replaced again, and flipped the row from the bridge's `reverted` back to `failed` |

Three defects, one root: writes to `metadata` that replace instead of merge, plus a watchdog that judges liveness by a column nothing refreshes during a long run. The agent's default deadline (22 min) already exceeds the watchdog window (20 min), so the reclaim was guaranteed, not a race.

AC-1 — The watchdog's reclaim PATCH merges the row's existing metadata (adds `error` + `watchdog_reclaimed_at`, never drops `executor` / `claimed_env` / `llm_on_ramp_override`), and tolerates null metadata. Pure builder `buildWatchdogReclaimPatch`, used by step 0b.
TEST: services/gateway/test/vtid-04011-watchdog-heartbeat.test.ts

AC-2 — `applyExecutionResult`'s failure path reads the row's current metadata and merges it (adds `error` + `failed_at`), via pure `buildExecutionFailurePatch`; a missing error string becomes `unknown execution failure` as before.
TEST: services/gateway/test/vtid-04011-watchdog-heartbeat.test.ts

AC-3 — A running agent execution heartbeats its row: `startExecutionHeartbeat` PATCHes `updated_at` on `/rest/v1/dev_autopilot_executions?id=eq.<id>&status=eq.running` every `AGENT_HEARTBEAT_MS` (default 60 s, floor 5 s), starts when `runAgentExecutionSession` begins and stops in its `finally`; a failed PATCH is logged, never thrown; `stop()` is idempotent; the timer is `unref`'d.
TEST: services/gateway/test/vtid-04011-watchdog-heartbeat.test.ts

AC-4 — The single-shot path and the reconciler's existing merge-style writes are unchanged; existing execute/reconciler suites stay green.
TEST: services/gateway/test/dev-autopilot-execute.test.ts
TEST: services/gateway/test/self-healing-reconciler-autopilot-link.test.ts

Not verified here: a live agent execution surviving past 20 minutes on the rebuilt image — the re-run of Test Run #4 is the first exercise. Not changed here, named as follow-ups: the agent re-ran an identically failing `tsc` nine times (a repeated-identical-check guard belongs in the loop), and the production gateway's dry-run watcher (not yet on VTID-04004/04005) still synthesizes `ci_passed`/`pr_merged` on staging-claimed rows until prod is promoted.
