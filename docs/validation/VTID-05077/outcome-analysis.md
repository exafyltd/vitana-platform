# VTID-05077 A4 — why the Dev Autopilot landed nothing since 2026-09-18

Source: live `dev_autopilot_executions` + `autopilot_recommendations` + `oasis_events` (read-only, 2026-10-12). 30 executions since 2026-09-18 ended reverted / failed / failed_escalated or sat in `ci`; 0 completed.

| # | Cause | Rows | Evidence | Status |
|---|---|---|---|---|
| 1 | Parallel Operator on-ramp batch (2026-09-18): many autopilot PRs on overlapping files opened at once | 11 (#3421–#3434) | reconciler "PR mergeable_state=dirty after 30m" ×3, "=blocked after 30m" ×2, the rest no reason recorded | Phase C (overlap check against every open PR, concurrency cap) |
| 2 | Merged, but the reconciler waited for the GCP-era `deploy.gateway.success` event that no AWS workflow emits, then failed and reverted | 5 (#3427 #3429 #3473 #3475 #3582) | "no deploy success event observed after 30m in deploying" | Already fixed by VTID-04215 (`deployTopicsForEnv`, commit match), after these rows |
| 3 | Real deploy/verification failures, auto-reverted | 4 (#3586 #3587 #3591 #3726) | revert PRs recorded | Working as designed |
| 4 | Executor runtime: container recycled mid-run (2026-10-06); 108 turns with no edit (2026-10-07) | 2 | watchdog / exploration-budget errors | Phase B gives the planner real context (better plans, less blind exploration) |
| 5 | Froze in `ci` when the kill switch was armed (CI watcher + auto-merge stop while armed) | 4 (#4016–#4019) | opened 2026-09-28..10-01, untouched since | Closed with a comment 2026-10-12 (this phase); the reconciler archives them (`auto_archived`) |
| 6 | Planner: half of all DeepSeek plans failed on the output cap and were silently written by the stage fallback | 128 of 246 calls in 7 days | `llm.call.failed` "returned no text: output cap reached (stop_reason=length, output_tokens=8000)" | This phase: thinking off on the planner call, Opus 4.6 fallback, fallback visible |

Also found: many failed rows carry no reason at all (`triage_report`/`metadata.error` empty) — the reconciler's revert path; and the planner's `plan.failed` said "unknown error". A3 fixes the planner side; the reconciler side is listed for Phase C.

Not touched: PR #4020 (dev-autopilot/257ba366) is open but its execution is already terminal (`failed_escalated`); left for the owner/Phase C sweep.
