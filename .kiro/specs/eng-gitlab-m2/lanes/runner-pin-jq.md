---
lane: runner-pin-jq
state: executing
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
updated: 2026-11-07T20:34Z
vtid: VTID-05612
claimed_by: kiro-exafy-202611071142-d7ed
branch: kiro/eng-gitlab-m2/runner-pin-jq
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

### 2026-11-07T20:08Z · ci-plan-spar · ready (VTID allocated)
VTID-05612 allocated after policy approval (converged-auto-v1).

### 2026-11-07T20:34Z · kiro-exafy-202611071142-d7ed · ready → executing
Tests first: the new fleet-structure and free-tier-guard cases are red on origin/main (outputs/red-on-base.txt), green with the change (outputs/green.txt). Two existing assertions are tightened on purpose (acceptance.md, Contract). Both installers pin and hold the helper; .gateway installs jq; the fleet runbook records the recovery and the fleet size.

### 2026-11-07T20:40Z · agent-vitana-lane-reviewer-202611072035-19f3 · review
review: accept
head: 5d7650d2c2e637c12c51a9a6a1de3b9d701798e9
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4858
Findings: non-blocking: green.txt has no counts for free-tier-guard; green comes from CI unit run 42411784060 instead.
non-blocking: the new jq test uses a loose 400-character window; test 10 pins the exact jq line first and the rest of .gateway to milestone 1, platform only.
non-blocking: fleet-structure tests 24 and 36 and free-tier test 10 only tighten; red on base fails 24, 36, 39, 10 and 52 for the right reasons.
non-blocking: item 10 holds (exit 1 with no fallback, both packages held, jq before pnpm, typecheck and gateway-jest unchanged, v1 and rehearsal files untouched; M1 host/ci-platform.yml and RUNBOOK.md correctly unchanged).
non-blocking: the diff makes no live or production write; the owner-instructed engineering-account changes are only recorded in the evidence.
non-blocking: validate-pr, check-phase-2b-docs, Collab handoff, pr-gate, change-suite, validate and Phase 2B naming were still running at review time.
Next: the land step merges under §7b once every check on this head is green
