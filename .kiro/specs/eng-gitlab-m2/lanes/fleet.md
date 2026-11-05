---
lane: fleet
state: in-review
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/terraform/fleet.tf
  - infra/gitlab-engineering/terraform/fleet-ami.tf
  - infra/gitlab-engineering/host/fleet-manager-install.sh
  - infra/gitlab-engineering/host/fleet-image/**
  - infra/gitlab-engineering/RUNBOOK-m2-fleet.md
  - scripts/eng/fleet-structure.test.mjs
  - docs/validation/**
updated: 2026-11-05T19:38Z
claimed_by: kiro-exafy-202611021438-cff7
branch: kiro/eng-gitlab-m2/fleet
pr: https://github.com/exafyltd/vitana-platform/pull/4716
vtid: VTID-05536
---
# Lane: fleet (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.2. Starts when M1 lane gitlab-infra is done (terraform validate needs M1's main.tf). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05536 allocated after policy approval (converged-auto-v1).

### 2026-11-05T12:40Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed. Built from the tip of the M1 branch (8bae0d492d4) while M1 (#4692) waited for its re-review, because `terraform validate` needs M1's `main.tf` in the tree (the lane text says it starts when `gitlab-infra` is done). This PR was opened after M1 merged, and the branch was rebuilt as one commit on `origin/main`. Tests first (`scripts/eng/fleet-structure.test.mjs`: red on the bare base and on empty files), then `fleet.tf`, `fleet-ami.tf`, the image component, `fleet-manager-install.sh` and the RUNBOOK. The mutation harness found one gap in the test (fixed). Decisions taken inside the plan (listed for Gate 2): KMS grants for the Auto Scaling and Spot service roles; the Spot quota looked up by name; DNS egress limited to the VPC CIDR; the image build machine reuses the job security group; the plugin version floats.

### 2026-11-05T19:38Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4716. Evidence regenerated from the final code: 38 cases (red on the bare base and on empty files, green 38 of 38), 133 mutations all caught, `terraform fmt -check` and `terraform validate` with M1's `main.tf`, the whole script set 677 tests with 0 failures on Node 22 and Node 20, secret scan 0 matches, a cost estimate of about $39.77 a month always on. Ready for a review on the current head. Owner note: the default `fleet_max_instances` needs 96 vCPUs in both Standard quotas; the apply stops at the quota check and prints the commands.
