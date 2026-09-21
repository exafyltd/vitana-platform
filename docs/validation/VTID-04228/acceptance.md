# VTID-04228 — Live staging verification of the Dev Autopilot + self-healing loops

Status: DONE for the scan → plan leg (AC-1..AC-4, AC-7 met with live rows);
AC-5 and AC-6 are PARTIAL and say exactly where the chain stopped and why.
`outputs/baseline-before.txt` is the read-only state before #3529 merged
(`70bd61a`); `outputs/trace-*.txt` are the read-only Supabase/CloudWatch
reads after it. Nothing here touched production: every write went through
the pipeline's own governed paths (two `workflow_dispatch` runs against the
staging default, the staging gateway routes, the staging executor loop).
`dev_autopilot_config` was NOT flipped and `DEV_AUTOPILOT_EXECUTOR` was NOT
set (nothing reached the executor to observe).

## Result summary

| AC | Result | Evidence |
|---|---|---|
| AC-1 | MET — staging served `70bd61a4582d`, `env=staging`, 10/10 samples, task def `vitana-gateway:491` | outputs/build-info-after.txt |
| AC-2 | MET — run #325 `POST ok 200`, 2334 signals, 15 new findings (run #324 had been a 404) | outputs/dev-autopilot-dispatch-run.txt |
| AC-3 | MET — 15 `autopilot_recommendations` rows, `source_type=dev_autopilot`, `status=new`, 15:21:17–19 UTC (0 in the prior 14 days) | outputs/trace-recommendations.txt |
| AC-4 | MET — 41 `llm.call.completed`, `stage=planner`, `provider=bedrock`, `model=eu.anthropic.claude-opus-4-5-20251101-v1:0`, `fallback_used=false`; 0 anthropic, 0 vertex, 0 failed; 9 `dev_autopilot_plan_versions` rows | outputs/trace-llm-calls.txt |
| AC-5 | PARTIAL — 0 `dev_autopilot_executions`; the gate is the live `dev_autopilot_config` row `auto_approve_enabled=false` (`kill_switch=false`), shared by prod and staging, not flipped. Executor + watcher confirmed armed (`dry_run=false`) on the new task def | outputs/trace-executions.txt |
| AC-6 | PARTIAL — E2E-ORB-MONITOR #2758 passed all legs against staging, so the failure-only report step never ran; `/self-healing/report` 2xx and `self_healing_log` rows remain unobserved (0 rows). Service token now present on the task def | outputs/trace-self-healing.txt |
| AC-7 | MET — gaps-report.md §5a–5d answer item 5 live; §5e adds three defects the run itself exposed (duplicate concurrent planning ×10, run row never finalized, planner cost reported $0) | gaps-report.md |

## Acceptance criteria

AC-1 Staging serves the merge commit `70bd61a` before any verification is taken (§15: a green workflow is not evidence).
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info → `git_commit` starts with `70bd61a4582d`, `env=staging` (outputs/build-info-after.txt)

AC-2 `workflow_dispatch` of DEV-AUTOPILOT.yml with `dry_run=false` POSTs the scan to the staging gateway and is accepted (2xx, not the 404 of run #324).
CURL: the run's "Run scanner + POST to gateway" step log shows `POST ok` against preview-aws-gateway (outputs/dev-autopilot-dispatch-run.txt)

AC-3 Rows with `source_type='dev_autopilot'` appear in `autopilot_recommendations` (there were 0 in the prior 14 days).
CURL: Supabase SQL over `autopilot_recommendations` (outputs/trace-recommendations.txt)

AC-4 `lazyPlanTick` plans the new findings through `callViaRouter('planner')` on Bedrock — `oasis_events` `llm.call.completed` with `stage=planner`, `provider=bedrock`, never `anthropic` or `vertex`.
CURL: Supabase SQL over `oasis_events` (outputs/trace-llm-calls.txt)

AC-5 `autoApproveTick` → `dev_autopilot_executions` row → executor claim (`metadata.executor='agent'`) → PR held as `awaiting_approval`; OR the exact gate that stops it is named with the live row that proves it.
CURL: Supabase SQL over `dev_autopilot_executions` / `dev_autopilot_config` (outputs/trace-executions.txt)

AC-6 `workflow_dispatch` of E2E-ORB-MONITOR.yml against staging: a failing leg reaches `POST /api/v1/self-healing/report` on staging (2xx, not 401) and produces `self_healing_log` / OASIS rows, and the reconciler picks up any stale row.
CURL: the run's "Report failure to self-healing" step + Supabase SQL over `self_healing_log` (outputs/trace-self-healing.txt)

AC-7 Item 5 of the brief is answered with live data, not fixed silently.
TEST: docs/validation/VTID-04228/gaps-report.md (kill_switch / auto_approve_enabled read live; architecture-investigator fix proposed; AUTOPILOT_LOOP_ENABLED gating traced to code)
