---
lane: pipelines
state: ready
next_actor: kiro
depends_on: []
executor: claude
reviewer_seat: exafyltd
reviewer: exafyltd (exceptions seat; the reviewer agent is refused on claude lanes)
repos: [exafyltd/vitana-platform]
paths:
  - config/delivery/**
  - scripts/eng/pipeline-gen.mjs
  - scripts/eng/pipeline-gen.test.mjs
  - scripts/eng/affected-parity.test.mjs
  - scripts/eng/services-parity.test.mjs
  - scripts/eng/fixtures/v1-pr-files.json
  - scripts/eng/fixtures/platform-pr-files.json
  - infra/gitlab-engineering/ci/tpl-checks.yml
  - infra/gitlab-engineering/ci/tpl-main.yml
  - infra/gitlab-engineering/ci/tpl-nightly.yml
  - infra/gitlab-engineering/ci/tpl-assist.yml
  - infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml
  - infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml
  - docs/validation/**
updated: 2026-11-06T23:43Z
vtid: VTID-05550
---
# Lane: pipelines (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.3, §3.4, §3.6 (orchestration), §3.9 (jobs) and T3, for both repositories. Starts when eng-gitlab-m2 lane settings is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05550 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)

### 2026-11-06T23:43Z · kiro-exafy-202611061823-5cb2 · admin: executor kiro -> claude (admin lane VTID-05565)
Reassigned by lane `claude-migration-lanes/reassign-migration` (lane_admin): `executor: kiro` -> `claude`, `reviewer_seat` -> `exafyltd`, `seat: exafy` removed; `paths` and `vtid` unchanged. On the owner's instruction (2026-11-06) the earlier Kiro PR for this lane was closed and its claim (older than 24 h) was released. Next: Claude Code claims and builds this lane from `ready`.
