---
lane: settings-fix-v2
state: ready
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
updated: 2026-11-07T16:04Z
vtid: VTID-05607
---
# Lane: settings-fix-v2 (repo vitana-platform)
Same fix as lane `settings-fix`: the settings sync wrote secret values through `file:///dev/stdin`, which the AWS CLI cannot
read under systemd, so every secret write failed on the GitLab machine (owner run 2026-11-07 10:33Z). The fix writes each value to
a 0600 file in a 0700 temp directory, removed in finally. Re-proved on a branch whose name matches this lane id:
`kiro/eng-gitlab-m2/settings-fix-v2`. The earlier branch and PR of `settings-fix` stay as they are. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-07T16:03Z · kiro-exafy-202611071602-6cfa · ready
Lane created by this plan PR (late lane). Depends on settings (done). Builder: seat exafy.

### 2026-11-07T16:04Z · ci-plan-spar · ready (VTID allocated)
VTID-05607 allocated after policy approval (converged-auto-v1).
