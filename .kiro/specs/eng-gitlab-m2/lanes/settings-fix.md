---
lane: settings-fix
state: parked
parked_from: ready
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
updated: 2026-11-07T20:24Z
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

### 2026-11-07T20:24Z · kiro-exafy-202611072023-b820 · ready → parked (superseded)
superseded by settings-fix-v2 (VTID-05607), done on main. No further work in this lane.
