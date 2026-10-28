# VTID-04327 — retire worker-runner and autopilot-worker (Orchestrator plan §8.5)

Owner decision 2026-09-23: "Yes, do that" — retire both.

Evidence: vitana-worker-runner logged "[VTID-01200] Polled: 0 pending, 0 eligible"
on every poll read (VTID-03516 restricted its claim pool to autonomous tasks,
and the agent executor now does that work). autopilot-worker is a `claude -p`
daemon for a developer machine; DEV_AUTOPILOT_USE_WORKER is set on no deploy
workflow.

## Acceptance criteria

AC-1: The gateway's autopilot-worker lane is off unconditionally: a set
DEV_AUTOPILOT_USE_WORKER is ignored (logged once) and the claude_subscription
provider reports unavailable, so nothing enqueues work no one consumes.
TEST: services/gateway/test/services/dev-autopilot-worker-queue.test.ts

AC-2: services/worker-runner and services/autopilot-worker are removed with
their deploy workflow (AWS-PROD-DEPLOY-WORKER-RUNNER.yml), TEST-SUITE matrix
entries, npm-audit and DEV-AUTOPILOT scan targets, and service-path-map entry;
the path-to-regexp floor test that guarded worker-runner's lockfile goes with
the code it guarded. The rest of the gateway suite is unaffected.
TEST: services/gateway/test/services/dev-autopilot-worker-queue.test.ts (full suite: outputs/jest-full.txt)

## Not in this PR

Stopping the vitana-worker-runner ECS service: it is on the VTID-04324
workflow's allowlist and waits on the owner's go-ahead (partial scale-down
of 2026-09-23, see VTID-04324).
AUTO-DEPLOY.yml still names worker-runner; it dispatches EXEC-DEPLOY.yml,
which VTID-04225 already deleted — a dead workflow for its own cleanup.
