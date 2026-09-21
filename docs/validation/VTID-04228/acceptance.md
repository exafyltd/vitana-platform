# VTID-04228 — Live staging verification of the Dev Autopilot + self-healing loops

Status: IN PROGRESS — results are appended to `outputs/` as they are taken;
`outputs/baseline-before.txt` is the read-only state before #3529 merged
(`70bd61a`). Nothing below touches production; every write goes through the
pipeline's own governed paths (a `workflow_dispatch`, the gateway routes).

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
