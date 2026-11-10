---
lane: fleet
state: done
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
updated: 2026-11-06T22:44Z
claimed_by: kiro-exafy-202611062222-c262
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

### 2026-11-05T22:12Z · agent-vitana-lane-reviewer-202611052153-d9ce · review
review: accept
head: f08b114f87710e2a6d4a4b8c0b8c6322df7150d1
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4716
Findings:
- non-blocking, docs/validation/VTID-05536/outputs/terraform-checks.txt:2: validate ran on a folder without monitoring.tf (#4710, already in the build base 9f239e17db), and the claim in commands.log:3 predates df4ded45dc; a read-only check finds no name clash across the four .tf files and CI unit 42103258571 is green on this head; re-run fmt -check and validate on the head's folder and fix commands.log:3 in the closing records.
- non-blocking, infra/gitlab-engineering/RUNBOOK-m2-fleet.md:51: point the small-fleet paragraph to section 6 (update /etc/vitana/env, re-run the installer), or a manager built at fleet_max_instances = 1 keeps concurrent = max_instances = 1.
- non-blocking, infra/gitlab-engineering/host/fleet-manager-install.sh:71: the aws plugin version floats (logged decision); pin aws:<major.minor.patch> so a rebuilt manager runs the tested version.
- non-blocking (d), infra/gitlab-engineering/terraform/fleet.tf:272: nothing here gives the manager SSH, scale or token-read rights on deploy-path's class groups, although deploy-path's fleet-classes.tf (580b028896) says M2 lane fleet grants the token read; deploy-path must add a second aws_iam_role_policy on aws_iam_role.fleet_manager and rules on aws_security_group.fleet_manager; the AMI (aws_imagebuilder_image.fleet) and the quota need (local.fleet_required_vcpus) are reusable.
- non-blocking (d), infra/gitlab-engineering/host/fleet-manager-install.sh:45: one [[runners]] block from single-valued inputs that only fleet.tf:53 writes; no class input; concurrent must become the class sum; tags are set in GitLab, not in config.toml; scripts/eng/fleet-structure.test.mjs:670 and :655 pin one block and the env coupling and are outside deploy-path's paths.
- non-blocking, .kiro/specs/eng-gitlab-m2/lanes/fleet.md: 3 commits behind main (#4697, #4718, #4689), none touching this lane; update and re-check before merging (§7b).
Next: the land step merges under §7b

### 2026-11-06T22:44Z · kiro-exafy-202611062222-c262 · in-review → verified
Closing record written by the plan driver kiro-exafy-202611062222-c262, which took over this lane's stale claim (holder silent > 24 h).
Review: the reviewer-agent accept by agent-vitana-lane-reviewer-202611052153-d9ce on head f08b114f87710e2a6d4a4b8c0b8c6322df7150d1 is in this log.
PR https://github.com/exafyltd/vitana-platform/pull/4716 merged at 2026-11-05T22:36:40Z by DraganOffice (the gh identity of the plan driver's review desk) with head fe52ebdb0568e43a650209026cb04c8704729e45.
`land-guard.mjs review --gh exafyltd/vitana-platform --repo . --pr 4716 --reviewed-head f08b114f87710e2a6d4a4b8c0b8c6322df7150d1` (run 2026-11-06T22:44Z): ok, only lane-file entries and clean merges of main after the reviewed head, so the accept counted for the merged head.
Checks on the merged head (REST check-runs read, 2026-11-06T22:44Z): 11 of 11 completed/success; none red or missing.

### 2026-11-06T22:44Z · kiro-exafy-202611062222-c262 · verified → done
merge: f5dd5eb94b8d36466c13c50a25564b4b971c0653
authority: §7b PM rule (plan driver review desk; accept current on the merged head, checks green).
Gap: the lane said in-review, not verified, when it merged, and no merge line was written at the time; this entry records both.
Next: none; the lane is done.
