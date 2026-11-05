---
lane: deploy-path
state: executing
claimed_by: kiro-exafy-202611051643-bc0a
branch: kiro/agentic-delivery/deploy-path
pr: https://github.com/exafyltd/vitana-platform/pull/4714
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/deploy/**
  - scripts/eng/gitlab-oidc-structure.test.mjs
  - scripts/eng/fleet-classes-structure.test.mjs
  - infra/gitlab-engineering/ci/tpl-deploy.yml
  - infra/gitlab-engineering/terraform/fleet-classes.tf
  - infra/gitlab-engineering/host/fleet-manager-install.sh
  - infra/gitlab-engineering/RUNBOOK-delivery-aws.md
  - scripts/aws/iam/gitlab-oidc-*.json
  - scripts/aws/setup-gitlab-oidc.sh
  - docs/validation/**
updated: 2026-11-05T17:19Z
vtid: VTID-05546
---
# Lane: deploy-path (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.2 (classes), §3.6 step 2, §3.7, §3.8 and the roles of §7. Starts when eng-gitlab-m2 lane fleet is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05546 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T17:12Z · kiro-exafy-202611051643-bc0a · ready → executing
Claimed and built from the spec by a separate builder session (seat exafy; driver kiro-exafy-202611041929-802c).
Deploy scripts (build, push by digest, ECS deploy and rollback, previews), `tpl-deploy.yml` (the six jobs of plan §9),
`fleet-classes.tf`, the GitLab OIDC provider and six roles with `setup-gitlab-oidc.sh` (dry run by default) and the runbook.
Tests first: red on base 19 of 19 (38 of 38 against stubs); green 38 of 38; UNIT 685 tests, 684 pass, 0 fail, 1 skip;
`terraform validate` with M1 valid. Decisions and the parts that wait for M2 fleet in `docs/validation/VTID-05546/acceptance.md`.
### 2026-11-05T17:19Z · kiro-exafy-202611051643-bc0a · executing
PR https://github.com/exafyltd/vitana-platform/pull/4714 open (head da14ad0ae8); preflight passed; validate-pr-locally APPROVED.
Final counts after one fix commit: red on base 19 of 19 (39 of 39 against stubs), green 39 of 39, UNIT 686 tests, 685 pass,
0 fail, 1 skip. Stays executing: waits for eng-gitlab-m2 lane fleet (no branch yet) for the `host/fleet-manager-install.sh`
runner blocks and their tests, SSH ingress and manager permissions on the two class groups, `terraform validate` with
`fleet.tf`, and the rootless builds on the M2 job image (acceptance.md "Waits for M2 fleet").
