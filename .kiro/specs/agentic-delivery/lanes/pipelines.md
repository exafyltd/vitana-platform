---
lane: pipelines
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - config/delivery/**
  - scripts/eng/pipeline-gen.mjs
  - scripts/eng/pipeline-gen.test.mjs
  - scripts/eng/affected-parity.test.mjs
  - scripts/eng/services-parity.test.mjs
  - scripts/eng/fixtures/v1-pr-files.json
  - scripts/eng/fixtures/platform-pr-files.json
  - infra/gitlab-engineering/ci/tpl-checks.yml
  - infra/gitlab-engineering/ci/tpl-main.yml
  - infra/gitlab-engineering/ci/tpl-nightly.yml
  - infra/gitlab-engineering/ci/tpl-assist.yml
  - infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml
  - infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml
  - docs/validation/**
claimed_by: kiro-exafy-202611051542-d83b
branch: kiro/agentic-delivery/pipelines
pr: https://github.com/exafyltd/vitana-platform/pull/4709
updated: 2026-11-05T22:01Z
vtid: VTID-05550
---
# Lane: pipelines (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.3, §3.4, §3.6 (orchestration), §3.9 (jobs) and T3, for both repositories. Starts when eng-gitlab-m2 lane settings is done (plan §9). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-04T23:03Z · kiro-exafy-202611041929-802c · ready
Lane created with the plan.

### 2026-11-05T00:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05550 allocated after policy approval (converged-auto-v1).
### 2026-11-05T02:53Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T02:59Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
### 2026-11-05T16:20Z · kiro-exafy-202611051542-d83b · ready → executing
Claimed and built from the spec by a separate builder session (seat exafy; driver kiro-exafy-202611041929-802c).
`config/delivery/services.json` (vitana.delivery-services/v1: 6 v1 services, 53 platform services and areas, 18 and 47
checks) renders the two pipeline files with `scripts/eng/pipeline-gen.mjs`; templates tpl-checks/main/nightly/assist.
Tests first: red on base 3 of 3 files (22 of 22 against stubs); green 27 of 27; `--check` exit 0; Psych cross-check 6/6;
UNIT 648 tests, 647 pass, 0 fail, 1 skip. Decisions and the not-done list in `docs/validation/VTID-05550/acceptance.md`.
### 2026-11-05T16:23Z · kiro-exafy-202611051542-d83b · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4709 open; preflight passed. Next: the driver requests the reviewer agent.

### 2026-11-05T16:54Z · agent-vitana-lane-reviewer-202611051654-f516 · review
review: changes
head: e2c507323d72fcc9a720cebcf45cd47b7d5c56af
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4709
Findings:
- blocking: config/delivery/services.json:1772. These checks cannot pass on GitLab: cicdl-lint-services needs jq, which node:20-bookworm lacks; openapi-enforce writes to the unset $GITHUB_OUTPUT (:1804); sql-auth-bridge runs npm on postgres:16 (:1897); validator-check gets an empty CI_MERGE_REQUEST_DESCRIPTION on main, nightly and train refs, so --pr-body-check exits 11 (:1739). Platform main would be red on every landing.
- blocking: config/delivery/services.json:466. android-module runs on eclipse-temurin:17-jdk without Node or the Android SDK. Every v1 src/** change selects it (mobile paths :136), so web merge requests never reach gate and v1 main would be red.
- blocking: infra/gitlab-engineering/ci/tpl-checks.yml:66. pr-gate-report passes no --title (gate.mjs:22-23), so scope, sparring and red-green skip on every merge request; red-green also gets no dependency install. The enforce switch would enforce nothing (plan §4).
- blocking: config/delivery/services.json:1739. Partial ports run fewer checks than GitHub: VALIDATOR-CHECK keeps only --pr-body-check, dropping the path-ownership, evidence-pack, acceptance-mapping, CSP, build, route-mount, OASIS and merge-deploy gates; dev-autopilot-impact sets no IMPACT_SCAN_BASE and can fall back to HEAD~1 (:1765).
- blocking: config/delivery/services.json:520. vitana-v1 PR-GATE preview-e2e (runs on a local vite preview, needs no T4 URL), the gate self-test and the Kiro steering self-test have no GitLab job.
- blocking: scripts/eng/pipeline-gen.test.mjs:277. The sibling-sweep test requires jobs only for fate t1; E2E-PREVIEW-ORB (T4, services.json:631) maps to [] and the test passes.
- non-blocking: tpl-nightly.yml:20. The T3 CI-health report job is not generated; record the deferral or generate it.
- non-blocking: Built before eng-gitlab-m2 settings is done (plan §9; PR #4711 in review, owns ci/**). After settings merges, merge main, re-check the settings interfaces and re-review that head.
- non-blocking: tpl-deploy.yml, tpl-verify.yml and gitlab-gates.mjs are not on main yet; GitLab refuses a pipeline whose include is missing.
- non-blocking: tpl-checks.yml:14. Jobs use the public node:20-bookworm image, not the M2 toolchain image of plan §3.4 (ECR Public anonymous cap, VTID-05415).
- non-blocking: GATE_BASE is empty on main and nightly and checks keep the shallow clone, so ratchet and migration diffs pass only in report-only mode. gate needs 47 of GitLab's default limit of 50. The .delivery-ran markers come from untrusted jobs.
- non-blocking: tpl-assist.yml:44. I18N_PROVIDER gemini follows plan §3.9 but conflicts with CLAUDE.md AI-27; a plan or owner question.
- non-blocking: Independent by session id (builder d83b, caller 802c only as driver, no caller commit). CI 11/11 green per the caller; not re-read because GraphQL is blocked here. Red/green evidence is credible. No issue with paths, weakening, live writes, UI or protected files.
Next: the lane's seat fixes the blocking findings
### 2026-11-05T22:01Z · kiro-exafy-202611051542-d83b · in-review → executing
Review changes on e2c50732 (entry above): fixing the six blocking findings.
