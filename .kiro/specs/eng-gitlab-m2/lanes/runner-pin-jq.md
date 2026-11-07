---
lane: runner-pin-jq
state: ready
next_actor: kiro
depends_on: [fleet, settings]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/host/fleet-manager-install.sh
  - infra/gitlab-engineering/host/runner-install.sh
  - infra/gitlab-engineering/ci/platform.gitlab-ci.yml
  - infra/gitlab-engineering/RUNBOOK-m2-fleet.md
  - scripts/eng/fleet-structure.test.mjs
  - scripts/eng/free-tier-guard.test.mjs
  - docs/validation/**
updated: 2026-11-07T20:06Z
---
# Lane: runner-pin-jq (repo vitana-platform)
Two defects the first runs on the live GitLab showed (eng-gitlab-m1/gitlab-verify, VTID-05555, evidence in
`docs/validation/VTID-05555/outputs/read-1-findings.md`):
1. `host/fleet-manager-install.sh:112` and `host/runner-install.sh:26` pin `gitlab-runner=$RUNNER_VERSION` (19.5.2-1) but not
   `gitlab-runner-helper-images`. apt takes the newest helper (19.5.3-1) and refuses, so the fleet manager never installed the runner
   (bootstrap log 2026-11-06T21:55Z, "held broken packages"). Fix: pin both packages to `$RUNNER_VERSION` and hold both.
2. The `.gateway` jobs of `ci/platform.gitlab-ci.yml` run on `node:20-bookworm`, which has no `jq`; GitHub's ubuntu-latest has it.
   On GitLab, gateway-jest fails 28 tests across the four shards, with `jq: not found` 22 times (pipelines 154, 155). Fix: install
   `jq` in the `.gateway` before_script, so the jobs run what GitHub runs.
Also: `RUNBOOK-m2-fleet.md` records the fleet size the owner set on 2026-11-07 (5) and that `terraform.tfvars` must say so.
VTID from PLAN-SPAR (late lane); never by hand.

## Log
### 2026-11-07T20:06Z · kiro-exafy-202611071142-d7ed · ready
Lane created by this plan PR (late lane), on the owner's instruction of 2026-11-07 to run the GitLab migration work end to end.
Depends on fleet and settings (done). Builder: seat exafy.
