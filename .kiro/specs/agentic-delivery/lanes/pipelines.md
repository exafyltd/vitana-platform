---
lane: pipelines
state: in-review
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
updated: 2026-11-05T22:07Z
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
### 2026-11-05T22:07Z · kiro-exafy-202611051542-d83b · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4709 updated (fix round 1); preflight passed. Next: the driver requests a new review.
The six blocking findings fixed, tests red first: 9 of 36 fail on e6490b1cba, 36 of 36 pass after the merge of origin/main; UNIT 918 tests, 0 fail. Open items for the driver (impact ingest and PR comment, gl-verify trust for e2e-preview-orb, the 2700-character description limit) and the deferred CI-HEALTH job: docs/validation/VTID-05550/acceptance.md.

### 2026-11-05T23:04Z · agent-vitana-lane-reviewer-202611052231-b2d2 · review
review: changes
head: d5b609bf886cd30d4a8b3f0b5fdb39c441e4cd11
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4709
Findings:
- blocking: infra/gitlab-engineering/ci/tpl-assist.yml:43. T7 cannot replace I18N-PROPAGATE. ASSIST_DATA_PATHS is src/i18n only, so assist_finish (:55) commits the translations but drops the rewritten i18n-source-stamps/*.json. I18N-PROPAGATE commits both, and the v1 i18n gate reads the stamps (i18n-stamp-source.mjs --check-all, v1-delivery.gitlab-ci.yml:783). After the cut, every MR that changes German stays red and cannot land, and i18n-nightly re-translates the same keys every night. The fan-out uses --source=de (services.json:614, :627) instead of the English pivot I18N-PROPAGATE uses. No final step fails when a language is still behind, and no test checks what the assist commits.
- blocking: infra/gitlab-engineering/ci/tpl-assist.yml:44. I18N_PROVIDER gemini adds a Google LLM call path. CLAUDE.md AI-27 forbids it, and IF–THEN 9 takes the stricter rule over plan §3.9. deepseek is offered by I18N-PROPAGATE today and listed first in vitana-v1 CLAUDE.md, which also says the Gemini key is out of quota. Every translate call ends in '|| true', so a dead key finishes green. Use a non-Google default and pin it in a test.
- blocking: config/delivery/services.json:894. dev-autopilot-impact is selected only for services/gateway/** and the shared/other paths (platform-delivery.gitlab-ci.yml:909). GitHub runs it on every PR and fails the PR on a blocker. The blocker rules duplicate-table-name (supabase/migrations; the supabase area at services.json:1691-1697 has no checks) and new-oasis-event-requires-union (any non-test code, scripts/** included) are never enforced for those MRs, because the GitLab main run is a dry run. affected-parity.test.mjs:54 skips always-on workflows. Select the job for every path its blocker rules read, and add tests.
- blocking: scripts/eng/pipeline-gen.mjs:193. build-image (and preview-build:main, :173) has no needs, and the build stage follows full-suite (:144). The image build therefore waits for the whole full suite, against plan §3.6 step 1 and tpl-main.yml:2-3. Landing to STAGING-VERIFY then exceeds the plan §5 target, and one red full-suite job skips that landing's push, deploy, STAGING-VERIFY and record. Add needs: [] and a test.
- non-blocking: tpl-checks.yml:55, :78. The --repository, --repo-root and --platform-dir arguments do not match merge-queue's gitlab-gates.mjs (#4721 at 5308be19a9): it exits 2 on unknown options and exits 3 on a non-bare clone. acceptance.md:153 is stale. Align one side before cutover. tpl-deploy.yml (#4714) and tpl-verify.yml plus aws-secret.mjs (#4705) match this lane.
- non-blocking: (c) Landing before #4714, #4705 and #4721 is safe while GitLab delivery is not live. At eec9c243 the projects stay on settings' own files (free-tier-guard.test.mjs:399-408), and the sync copies files without linting them (gitlab-settings.mjs:433-440). All three files must be on main before cutover switches ci_file.
- non-blocking: (b) The \u002f escape in platform-pr-files.json (:1033, :3387) is sound. The strings are lane file names, not API paths; the parsed data is unchanged and pinned by AC-21. It relies on a blind spot of the raw-text guard, which settings or cut-settings should close by skipping fixtures or scanning parsed values. AC-21 copies the guard's regex (:34). A spot check against all 14 guard rules found no other hit, and the sync accepts all six file names.
- non-blocking: pipeline-gen.test.mjs:132. The platform gate lists 47 needs, but GitLab expands gateway-jest's 4 shards, so it counts 50, exactly the limit. The test counts entries, not instances.
- non-blocking: tpl-main.yml:34. e2e-preview-orb signs in as the test user and POSTs an ORB session start, which is not read-only (IF–THEN 31). It is manual, allow_failure and live-only. Decide at the cut whether to retire it.
- non-blocking: v1-delivery.gitlab-ci.yml:448. kiro-steering-selftest blocks the MR, while on GitHub it is report-only under the enforce switch (plan §4). Stricter, not weaker; record the decision or move it under the switch.
- non-blocking: platform-delivery.gitlab-ci.yml:735. GitLab truncates MR descriptions at 2700 characters, and validator-check fails closed on a truncated one. Every platform lane MR selects it, so the bridge or the PR template must handle this before the cut.
- non-blocking: acceptance.md:137 and :176-181 are stale. The line numbers predate the fix round, and the DELIVERY_MODE, schedules, allowlist and ASSIST_PUSH_TOKEN work belongs to cut-settings, not settings.
- non-blocking: services-parity.test.mjs:90. The v1 path-filter test checks service paths against themselves, so it cannot fail.
- non-blocking: Carried: merge only after eng-gitlab-m2 settings lands, then merge main (the head is one commit behind, 78bb4b3969) and review again. Also carried: the deferred CI-HEALTH job, the public node image, GATE_BASE on main and nightly, the impact ingest and PR-comment open items, and commands not yet run on a GitLab runner.
- non-blocking: All six blocking findings of 16:54Z are fixed. The new tests failed first (9 of 36) and pass now (36 of 36). CI is green on the head. No protected gate file, no weakened test, no out-of-path file and no live write in the evidence. Independent: builder d83b; caller 802c appears only in lane creation.
Next: the lane's seat fixes the blocking findings. After eng-gitlab-m2 settings lands, merge main and request a new review on that head.
