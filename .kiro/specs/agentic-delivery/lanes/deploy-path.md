---
lane: deploy-path
state: ready
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
updated: 2026-11-04T20:50Z
---
# Lane: deploy-path (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.2 (classes), §3.6 step 2, §3.7, §3.8 and the roles of §7. Starts when eng-gitlab-m2 lane fleet is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T20:50Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.
