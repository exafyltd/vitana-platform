---
lane: settings-fix
state: in-review
next_actor: kiro
depends_on: [settings]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/gitlab-settings.mjs
  - scripts/eng/gitlab-settings.test.mjs
  - docs/validation/**
updated: 2026-11-07T11:24Z
vtid: VTID-05591
---
# Lane: settings-fix (repo vitana-platform)
Fix forward of lane settings. The settings sync (`scripts/eng/gitlab-settings.mjs`) passed each secret value to the AWS CLI through
`--secret-string file:///dev/stdin`. Under systemd the CLI cannot read stdin (ParamValidation, errno 6), so every secret write failed on
the GitLab machine (8 failures in the first owner run, 2026-11-07 10:33Z). A fix exists on branch `kiro/fix/gitlab-settings-stdin`
(commit 279b590d7f): each write uses a 0600 file in a 0700 temp directory, removed in finally. The lane must re-prove it with a red test on
`origin/main` before its commit. VTID from PLAN-SPAR (late lane); never by hand.

## Log
### 2026-11-07T11:30Z · kiro-exafy-202611062222-c262 · ready
Lane created by a plan PR (late lane). Depends on settings (done). Builder: seat exafy.

### 2026-11-07T11:24Z · ci-plan-spar · ready (VTID allocated)
VTID-05591 allocated after policy approval (converged-auto-v1).

### 2026-11-07T12:00Z · kiro-exafy-202611062222-c262 · ready → executing
Claimed by the plan driver. Red on origin/main first: `docs/validation/VTID-05591/outputs/red-on-base.txt` (18 pass, 37 fail). The fix is the diff of commit 279b590d7f on `scripts/eng/gitlab-settings.mjs`.

### 2026-11-07T12:30Z · kiro-exafy-202611062222-c262 · executing → in-review
Green: `outputs/green.txt`, 55 of 55. PR https://github.com/exafyltd/vitana-platform/pull/4780 (branch kiro/eng-gitlab-m2/settings-fix).
Next: the reviewer agent on the PR head, then the land step under §7b.
