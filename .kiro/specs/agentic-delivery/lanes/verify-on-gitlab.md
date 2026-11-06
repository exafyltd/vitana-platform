---
lane: verify-on-gitlab
state: in-review
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/ci/staging-verify/run.mjs
  - scripts/ci/staging-verify/deploy-runs.test.mjs
  - scripts/eng/verify/**
  - infra/gitlab-engineering/ci/tpl-verify.yml
  - docs/validation/**
claimed_by: kiro-exafy-202611051219-be7f
branch: kiro/agentic-delivery/verify-on-gitlab
pr: https://github.com/exafyltd/vitana-platform/pull/4705
updated: 2026-11-05T17:46Z
vtid: VTID-05552
---
# Lane: verify-on-gitlab (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.6 steps 3 to 6 and 8. Starts at once; its template file merges after eng-gitlab-m2 lane settings is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05552 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)

### 2026-11-05T13:00Z · kiro-exafy-202611051219-be7f · ready → executing
Claimed and built from the spec by a separate builder session (seat exafy; driver kiro-exafy-202611041929-802c).
`run.mjs verify --deploy-runs-file` replaces the GitHub API call (missing file: T_cut = run start, no GitHub fallback);
`scripts/eng/verify/` maps GitLab to record-oasis.sh and vtid-auto-close.cjs (both unchanged), waits in shadow mode and
reads the §7 secrets; `infra/gitlab-engineering/ci/tpl-verify.yml` has the four jobs plus the nightly one. Tests first:
62 new, 60 red on base (2 GitHub-path guards pass by design); green 59/62, the 3 red are the known record-env cases until
lane prerequisites (#4690) lands (11/11 with its script). Decisions in `docs/validation/VTID-05552/acceptance.md`.

### 2026-11-05T15:35Z · kiro-exafy-202611051219-be7f · executing
PR https://github.com/exafyltd/vitana-platform/pull/4705 open (head 6d02651bae); preflight passed. Every check is green except
`unit`, whose only failures are the 3 record-env integration cases that need lane prerequisites (#4690). The lane file
waited for lane reseat (#4703). Next: #4690 lands, then this branch is updated with main and the driver requests the
reviewer agent.

### 2026-11-05T17:46Z · kiro-exafy-202611051219-be7f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4705 updated with main after lane prerequisites (#4690) landed; every test green. Next: the driver requests the reviewer agent.

### 2026-11-05T21:54Z · agent-vitana-lane-reviewer-202611052154-26d4 · review
review: accept
head: ab4aedc65aa4c2c28c6038ed223d0a1e56e86d58
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4705
Findings:
- non-blocking tpl-verify.yml:56: the deploy-runs file is a pre-run artifact of its own pipeline's deploy job, so it can never list the deploy that superseded the run. On GitLab T_cut is always the run start, nothing is attributed, and a superseded run with an early real failure ends `superseded`, not `failed` as on GitHub (run.mjs:479). This is fail-safe for PUBLISH. The fix is cross-lane (deploy-path, pipelines); log it as deferred.
- non-blocking tpl-verify.yml:69: GitHub STAGING-VERIFY's report job (status, PR comment, superseded full-run re-dispatch up to 3) has no GitLab counterpart beyond the bridge's statuses. A superseded nightly full run leaves no evidence; route it to lane pipelines.
- non-blocking vtid-close-env.mjs:43: PR_LABELS is always [], so the `vtid-keep-open` opt-out is lost while plan §4 keeps 'script and opt-outs'. Needs a plan-level answer (merge-bot label trailer or runbook).
- non-blocking vtid-close-env.mjs:38: owner merges in GitLab use the native squash template `%{title}` (#4711 eec9c24), have no Merge-Request trailer, and are never auto-closed.
- non-blocking tpl-verify.yml:22: lane pipelines must extend `.staging-verify-nightly` (outside plan §9's names). Nothing reads `.resource-groups` until late lane cut-settings.
- non-blocking record-env.test.mjs / vtid-close-env.test.mjs pin message text of record-oasis.sh and vtid-auto-close.cjs (quality-checks Tooling/docs).
- non-blocking lane log: link the unit run 42078197599 and, after merge, the first STAGING-VERIFY run (the GitHub-path proof).
- non-blocking tpl-verify.yml:101 (check c, informational): live-mode `.vtid-close` uses the production gateway's governed completion endpoint and `.record` writes oasis_events, as GitHub does today. Both are off in shadow mode; no live call in tests or evidence.
- non-blocking commands.log:9 (independence): the caller wrote only the creation entry, and every executing entry and commit is be7f. The builder ran the driver's heartbeat under 802c's id (a heartbeat ref, not lane work). Not self-review under §3.
Next: the land step merges under §7b once eng-gitlab-m2 lane settings (#4711) is done (plan §9), after bringing the branch up to date with main and re-running the checks. A clean merge of main keeps this review current under §3 through land-guard; on the PM path a merge of main needs a new review. Record the deferred findings in blockers.md.
