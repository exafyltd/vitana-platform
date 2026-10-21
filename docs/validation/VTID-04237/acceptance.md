# VTID-04237 — Enable Dev Autopilot auto-approve on staging behind a held PR

Owner instruction (2026-09-21, in conversation): "Flip auto_approve_enabled on
staging and rerun the scan." Two facts shape how that is done:

1. `dev_autopilot_config` is ONE row (`id=1`) shared by prod and staging. The
   flip is effectively staging-only anyway: the prod gateway task def
   (`vitana-gateway-awsdr` rev 114) has `DEV_AUTOPILOT_EXECUTOR_ENABLED=false`,
   so `startBackgroundExecutor()` — and with it `autoApproveTick` — never runs
   on prod. Only the staging gateway ticks.
2. The executor task def (`vitana-autopilot-executor` rev 21) carried neither
   `DEV_AUTOPILOT_EXECUTOR` nor `DEV_AUTOPILOT_PR_APPROVAL_REQUIRED`, and
   `autoApproveTick` stamps neither `metadata.executor` nor
   `metadata.require_approval` on the rows it creates. Flipping first would
   have run single-shot executions that open PRs which the LIVE staging
   watcher (`DEV_AUTOPILOT_WATCHER_LIVE=true`) merges on green — unattended
   merges to `main`, the opposite of the "held PR" the brief specifies.
   So the pins go in first, then the flip, then the scan.

## Result (16:45 UTC)

| AC | Result |
|---|---|
| AC-1 | MET — both workflows pin both values; prod gateway untouched (#3533 → `2b55e03`) |
| AC-2 | MET — 8 suites / 96 tests green locally, CI green on 36d885e |
| AC-3 | MET — executor task def rev 22 carries both (run #21 on main; the branch-ref dispatch #20 was refused by the main-only OIDC trust); staging gateway serves `197a76a` (VTID-04236 landed on `main` right after; it contains `2b55e03`) on task def `vitana-gateway:493`, which carries both values |
| AC-4 | MET — flipped 16:28:12Z, `kill_switch` false (outputs/config-flip.txt) |
| AC-5 | MET — 9 executions auto-approved unattended, all `claimed_env=staging`, all dispatched via `ecs:RunTask` to rev 22; **5 held at `awaiting_approval`** with a pushed `dev-autopilot/<exec8>` branch and a stored diff preview (42–75 agent turns); the npm-audit finding failed 3× on the 120-turn cap and is on its 4th attempt (outputs/trace-executions.txt) Addendum 18:16 UTC: attempt 4 of the npm-audit finding (`59875200`) is HELD at `awaiting_approval` (3-file policy/guard/test hand-off, `package.json` untouched); attempts 2-3 died in a 2-turn post-finish fix round (runner defect, see `outputs/trace-executions.txt`). |
| AC-6 | MET — 0 `execution.pr_opened`, 0 merges, no dev-autopilot PR on GitHub at 17:41; 2 findings blocked by the safety gate (allow-scope) and snoozed 7d |

## Acceptance criteria

AC-1 Both workflows pin `DEV_AUTOPILOT_EXECUTOR=agent` and `DEV_AUTOPILOT_PR_APPROVAL_REQUIRED=true` (executor task def; staging gateway for the in-process fallback), stripped-then-added; prod gateway workflow untouched.
TEST: services/gateway/test/vtid-04237-executor-agent-hold-pinned.test.ts

AC-2 The sibling pin suites that assert the executor strip list verbatim still pass with the two new names.
TEST: services/gateway/test/vtid-03850-staging-executor-dispatch-pinned.test.ts
TEST: services/gateway/test/vtid-04223-agent-memory-context.test.ts

AC-3 The live executor task def carries both values after `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` is dispatched (recorded reason), and the live staging gateway task def carries both after the merge deploys.
CURL: aws ecs describe-task-definition vitana-autopilot-executor / vitana-gateway → env (outputs/task-defs-after.txt)

AC-4 `dev_autopilot_config.auto_approve_enabled` is flipped to true only after AC-3 holds; `kill_switch` stays false.
CURL: Supabase SQL over dev_autopilot_config (outputs/config-flip.txt)

AC-5 A fresh `workflow_dispatch` of DEV-AUTOPILOT.yml (`dry_run=false`) against staging, then `autoApproveTick` creates `dev_autopilot_executions` rows, the executor claims them (`metadata.claimed_env=staging`), the agent runs, and each execution ends at `status=awaiting_approval` with a pushed branch and NO pull request — or the exact row/event that stopped it is named.
CURL: Supabase SQL over dev_autopilot_executions + oasis_events dev_autopilot.* (outputs/trace-executions.txt)

AC-6 Nothing merges to `main` without a human approve: zero `dev_autopilot.execution.pr_opened` / merge events for the auto-approved rows in the window.
CURL: Supabase SQL over oasis_events (outputs/trace-executions.txt)
