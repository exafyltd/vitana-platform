---
lane: pipelines
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
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
claimed_by: kiro-exafy-202611051542-d83b
branch: kiro/agentic-delivery/pipelines
updated: 2026-11-05T16:20Z
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
### 2026-11-05T16:20Z · kiro-exafy-202611051542-d83b · ready → executing
Claimed and built from the spec by a separate builder session (seat exafy; driver kiro-exafy-202611041929-802c).
`config/delivery/services.json` (vitana.delivery-services/v1: 6 v1 services, 53 platform services and areas, 18 and 47
checks) renders the two pipeline files with `scripts/eng/pipeline-gen.mjs`; templates tpl-checks/main/nightly/assist.
Tests first: red on base 3 of 3 files (22 of 22 against stubs); green 27 of 27; `--check` exit 0; Psych cross-check 6/6;
UNIT 648 tests, 647 pass, 0 fail, 1 skip. Decisions and the not-done list in `docs/validation/VTID-05550/acceptance.md`.
