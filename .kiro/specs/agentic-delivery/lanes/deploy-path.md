---
lane: deploy-path
state: done
claimed_by:
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
updated: 2026-11-08T11:30Z
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
### 2026-11-05T22:44Z · kiro-exafy-202611051643-bc0a · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4714 updated (round 2, after M2 fleet #4716 landed as f5dd5eb94b; main
merged in): the fleet manager renders one runner block per class (single use, unprivileged, own cache path, tokens from
Secrets Manager, a class without one stays off); seccomp/AppArmor unconfined only for the main class's BuildKit service;
SSH from the manager, its policy for the two class groups, the M2 image and key-grant role in fleet-classes.tf; runbook
step A2. Red on the merged base 14 of 21, green 21 of 21; M2's fleet tests 38 of 38; UNIT 971 tests, 0 fail; terraform
validate with fleet.tf valid; preflight passed. Open: D7 rootless builds (rehearsal); the class runners in the settings
sync (for the driver, acceptance.md). Next: the driver requests the reviewer agent.

### 2026-11-06T22:27Z · agent-vitana-lane-reviewer-202611062227-1ea5 · review
review: changes
head: b6155e618fafd61f2d2e2f801e552c285872ed01
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4714
Findings: blocking — D7 not met: no rootless builds of vitana-v1 and the gateway on the M2 job image with cold and cached times, and no recorded Buildah switch (docs/validation/VTID-05546/acceptance.md "Still open").
Findings: blocking — services_security_opt unconfines seccomp and AppArmor for every service container of every main-class job, including postgres:16 in 23 jobs; D1 allows it only for build jobs (infra/gitlab-engineering/host/fleet-manager-install.sh:108).
Findings: non-blocking — the D1 protected-runner item has no test; it depends on the settings sync (cut-settings), and the classes stay off until it lands.
Findings: non-blocking — check 10 passes: staging-only targets, no AWS-PROD-* change, aud and sub pinned per plan §7, no secret committed; RegisterTaskDefinition on * and the shared vitana/gateway ECR repository are inherited from vitana-gha-staging-deploy.
Findings: non-blocking — awscli and skopeo are installed unpinned at job start on the deploy class (tpl-deploy.yml).
Findings: non-blocking — services/gateway/BUILD_INFO is not refreshed in the GitLab build (build-image.sh).
Paths: all inside the lane. CI: 11 of 11 check runs on the head succeeded. Red to green: credible (19/19 and 39/39 red on base round 1, 14/21 red round 2, 51/51 green). No tests weakened. The caller session does not appear in the executing log.
Next: the lane's seat fixes the blocking findings

### 2026-11-08T11:30Z · kiro-exafy-202611081113-5a2e · in-review → executing (claim taken by planner decision D-A; blocked)
Claim `agentic-delivery/deploy-path` taken by seat exafy. The branch already contains origin/main (no merge needed), so the new commit fast-forwards the WIP head adf7fffd7f.

Tests (outputs/fleet-classes-red-to-now-20261108.txt): at adf7fffd7f, 17 of 21 pass and tests 14, 16, 17, 18 are red. Fixed in the test fixtures: test 16 unsets and test 17 expects the build class token like the other two classes; test 17 and 18 expect the installer to read the build token secret (the installer does). Now 20 of 21 pass. Test 14 is still red for a reason outside this lane (below). No test was weakened: the test 14 expectation changed from the main class to the build class, which matches this lane's own build class design.

Blocked: test 14 (BuildKit daemon only on the build class). Five build jobs still run on `vitana-eng-main`, so their BuildKit service runs on the class without the unconfined profile: `build-image:gateway`, `build-image:erp-bridge`, `build-image:kiro-runner`, `build-image:postgrest-aurora-proxy` (infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml) and `build-image:community-app` (ci/v1-delivery.gitlab-ci.yml). Those files are outside this lane's `paths`, so the lane cannot change them. Fix: tag those five jobs `vitana-eng-build`. Needs the planner to amend the paths or open a follow-up lane.

D-B (planner decision: build evidence from rehearsal A4, done on main) does not hold yet. eng-gitlab-m2/rehearsal on main records A1 to A4 and A8 as "pending the owner's live run (m2.sh rehearse)"; the evidence there is a simulation. So no real rootless build timing exists. D7 is amended in this log as the planner asked: the D7 build timings come from the owner's `m2.sh rehearse` run (A4), and until that run exists D7 stays open.

Next actor: planner. Decide (1) the paths amendment or follow-up lane for the five build jobs, and (2) whether D7 waits for the owner's rehearsal run. The lane stays `executing`, not `in-review`: a red test is not reviewable. The claim is released after the push. cutover and cut-settings stay blocked behind this lane.

### 2026-11-08T11:32Z · kiro-exafy-202611081113-5a2e · takeover note
Previous builder: kiro-exafy-202611071142-d7ed wrote the WIP commits adf7fffd7f and edf7b5af50 (2026-11-08 10:58 to 10:59Z). Its handover states the lane was released. This session takes over from that WIP head, and the commits of kiro-exafy-202611051643-bc0a (the builder of the review round) stay as they are.

### 2026-11-08T14:55Z · agent-vitana-lane-reviewer-202611081821-ef12 · review
review: accept
head: e8a7eb0e4f
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4714
findings: test 14 is strict; 21 of 21 (outputs/fleet-classes-after-main-merge-20261108.txt, checked against e8a7eb0e4f); red to green from 17 of 21 at adf7fffd7f; all 11 check runs on e8a7eb0e4f success; every changed file inside the lane paths; protected-gate-files.json unchanged.

### 2026-11-09 · kiro-closing-record · executing → done (closing record)
PR #4714 merged as `6dc6e1ba0c` on main. The reviewer-agent accept `review: accept` (2026-11-08T14:55Z, `agent-vitana-lane-reviewer-202611081821-ef12`) covers head `e8a7eb0e4f`, which is an ancestor of `6dc6e1ba0c`. The claim is released with this record. Filed on the owner's instruction on PR #4725 (2026-11-09). The reviewer accept and the merge are the evidence; nothing new was tested in this record.
