---
lane: github-bridge
state: in-review
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/github-bridge.mjs
  - scripts/eng/github-bridge.test.mjs
  - infra/gitlab-engineering/host/units/vitana-github-bridge.service
  - infra/gitlab-engineering/host/units/vitana-github-bridge.timer
  - infra/gitlab-engineering/RUNBOOK-github-bridge.md
  - docs/validation/**
updated: 2026-11-05T03:13Z
vtid: VTID-05548
claimed_by: kiro-exafy-202611050107-c4a6
branch: kiro/agentic-delivery/github-bridge
pr: https://github.com/exafyltd/vitana-platform/pull/4689
---
# Lane: github-bridge (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.13 (branches, pull requests, statuses). Starts when eng-gitlab-m2 lane gitlab-client is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05548 allocated after policy approval (converged-auto-v1).

### 2026-11-05T03:11Z · kiro-exafy-202611050107-c4a6 · ready → executing
Built `scripts/eng/github-bridge.mjs` (one tick: `kiro/*` and `claude/*` branches GitHub → GitLab under the one-writer rule, one merge request per open PR, `gitlab/<job>` statuses back, the PR closed with a link after landing; `assist-push`), the units `vitana-github-bridge.{service,timer}` and `RUNBOOK-github-bridge.md`.
Tests `scripts/eng/github-bridge.test.mjs`: red on base 49/49 failing against a no-behaviour stub (the module does not exist on base); green 49/49 on Node 20 and 22; UNIT 662 tests, 0 fail; mutation check 16/16 caught.
B3 dry run, read-only: 84 + 31 merge requests planned for 118 + 31 open PRs; 34 platform PRs ignored (33 `pm-agent/*`, 1 `i18n-db/*`).
Decisions and the open items for the driver: `docs/validation/VTID-05548/acceptance.md`.

### 2026-11-05T03:13Z · kiro-exafy-202611050107-c4a6 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4689 open; preflight passed. Next: the driver requests the reviewer agent.
