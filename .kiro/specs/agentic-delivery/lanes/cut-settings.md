---
lane: cut-settings
state: ready
next_actor: kiro
depends_on: [cutover]
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/gitlab-settings.mjs
  - infra/gitlab-engineering/settings/gitlab-settings.json
  - scripts/eng/gitlab-settings-delivery.test.mjs
  - docs/validation/**
updated: 2026-11-12T20:15Z
vtid: VTID-05562
---
# Lane `cut-settings`: the GitLab settings the cut needs that no lane builds yet
Tasks in `tasks.md` (group `<!-- lane: cut-settings -->`). VTID from PLAN-SPAR (a late lane of the converged plan);
never by hand.

The lanes of plan §9 rely on settings that the settings sync (eng-gitlab-m2 lane `settings`, then lane `cutover`) must
apply, but that no lane's tasks name (sync of `kiro-exafy-202611021438-cff7`, 2026-11-05 19:45Z, and the builders'
acceptance notes): the `bot-assist` account and its `ASSIST_PUSH_TOKEN` rotation (§3.9), the pipeline schedules of the
nightly and T3 jobs, the oldest-first resource groups of STAGING-VERIFY (§3.6, `tpl-verify.yml` `.resource-groups`), the
job-token allowlist between the two projects, the artifact size limit for image archives, push to `assist/*` for
`bot-land` and unprotected `train/*` refs (§3.5). They live in the settings file and the sync script, which lane
`cutover` changes, so this lane starts after `cutover` (`depends_on`).

## Log
### 2026-11-05T21:35Z · kiro-exafy-202611041929-802c · created → ready
Lane added through `_plan` by the plan driver. Next: PLAN-SPAR allocates its VTID; a builder of seat `exafy` that is not
the driver may prepare it on a scratch base of the settings and cutover trees, and pushes after `cutover` lands.

### 2026-11-05T21:34Z · ci-plan-spar · ready (VTID allocated)
VTID-05562 allocated after policy approval (converged-auto-v1).
### 2026-11-12T20:15Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
