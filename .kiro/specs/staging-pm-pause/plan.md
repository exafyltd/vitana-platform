---
change_class: standard
---
# plan(staging-pm-pause): keep the staging Project Manager off across deploys

Owner, 4 Nov 2026: stop the staging Project Manager flood, keep it stopped until the owner approves re-enabling,
and make the stop survive the next staging deploy. Production is not changed.

<!-- plan:begin -->
## Goal
The staging gateway (`vitana-gateway`, the AWS staging service) runs the Project Manager loop with
`PM_AGENT_ENABLED=true` and `PM_MODE=live`. Every two minutes the loop writes lane-status commits to `pm-agent/*`
branches, and each commit starts the PR checks. On 2 Nov 2026 that was about 1,500 to 3,000 runs per hour, 87% of
them from `pm-agent/*`. The loop starts only when `PM_MODE` is not `off` (`services/gateway/src/index.ts:1882`).

## Today (file:line on origin/main)
- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1229` upserts `{name:"PM_MODE", value:"live"}` on every staging
  deploy, so any staging deploy re-enables the loop.
- The running task definition `vitana-gateway:973` has `PM_MODE=live`. Changing it needs an ECS update, which the
  owner performs (governance §7a).

## Change (one line)
`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1229`: `value:"live"` → `value:"off"` for `PM_MODE` only.
`PM_AGENT_ENABLED` stays `true`, and no other env value, step or job changes.

## Sequencing (R1-F1)
Merging this PR triggers `AWS-STAGE-DEPLOY-GATEWAY.yml`, because its own file is in `on.push.paths`. That staging deploy
registers a new task-definition revision with `PM_MODE=off` and rolls `vitana-gateway`, so the merge itself makes the
pause durable. The owner ECS action below is the immediate relief, applied before the merge. Both lead to the same
state. The owner ECS action is not a precondition for the merge.

## Owner action for the running task (not performed by Kiro)
Register a new revision from `ci-audit/pm-pause/vitana-gateway-pm-off.json` (the current `:973` with `PM_MODE=off`),
then update the service so new tasks start with it. The Kiro session does not run these calls (§7a).

## Production
Not changed. `AWS-PROD-DEPLOY-GATEWAY.yml` does not set `PM_MODE`, and `vitana-gateway-awsdr` is not in scope.

## Re-enabling
Only on the owner's explicit approval, as a separate change that restores `"live"` on that line.

## Tests and evidence
- A one-line diff, checked by `git diff --stat` (one file, one line).
- `preflight.mjs` on the lane branch.
- The lane is governance-path (`.github/**`), so a reviewer-agent accept on the current head is required (§3a).

## Unchanged
Production workflows, `PR-GATE.yml`, `PLAN-SPAR.yml`, required check names, the PM code, the PM tick interval,
and the `CLAUDE_AVAILABLE` upsert.
<!-- plan:end -->
