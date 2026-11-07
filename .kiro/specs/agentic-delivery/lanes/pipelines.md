---
lane: pipelines
state: done
next_actor: claude
depends_on: []
executor: claude
reviewer_seat: exafyltd
reviewer: exafyltd (exceptions seat; the reviewer agent is refused on claude lanes)
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
updated: 2026-11-06T23:43Z
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

### 2026-11-06T23:43Z · kiro-exafy-202611061823-5cb2 · admin: executor kiro -> claude (admin lane VTID-05565)
Reassigned by lane `claude-migration-lanes/reassign-migration` (lane_admin): `executor: kiro` -> `claude`, `reviewer_seat` -> `exafyltd`, `seat: exafy` removed; `paths` and `vtid` unchanged. On the owner's instruction (2026-11-06) the earlier Kiro PR for this lane was closed and its claim (older than 24 h) was released. Next: Claude Code claims and builds this lane from `ready`.

### 2026-11-07T10:00Z · session_01Cp885Gw1CMmPDvDVHc7kw8 · ready -> executing (Claude Code)
Built by Claude Code (executor claude, claimed by this session). Carried Kiro's files from kiro/agentic-delivery/pipelines (8c204f9f81). Fixed the four blocking findings of review d5b609bf: T7 commits the i18n stamps; the assist provider is deepseek (no Google); the i18n fan-out translates from the English pivot; dev-autopilot-impact runs for supabase and scripts paths; build-image and preview-build:main declare needs: []. Also: the sql-live-room-cohost check for SQL-LIVE-ROOM-COHOST.yml (services-parity). Tests: pipeline-gen 28/28 (new tests red on the pre-fix files, green after), affected-parity 8/8, services-parity 5/5.

### 2026-11-07T10:40Z · session_01Cp885Gw1CMmPDvDVHc7kw8 · executing -> in-review (closing record, 1 of 3)
PR #4769 (head 58304b9e) merged as 3a1fffe3 under the owner's named instruction ("merge 4769"); the exafyltd seat did not review the head. Changes: one service list drives both pipelines; the four blocking findings of review d5b609bf are fixed; nine checks green on that head.
merge: 3a1fffe3f2  authority: owner instruction 2026-11-07 ("merge 4769")
Next: in-review -> verified and verified -> done, one step per PR.

### 2026-11-07T10:47Z · kiro-exafyltd-202611071045-e41d · review
review: accept
head: 3a1fffe3f2
reviewer: exafyltd (exceptions seat; the reviewer agent is refused on claude lanes)
PR: https://github.com/exafyltd/vitana-platform/pull/4769 (merge 3a1fffe3f2; fixes in 58304b9ec1)
checks (run read-only on 3a1fffe3f2): pipeline-gen.mjs --check exit 0 (both generated files ok); pipeline-gen.test 28/28; affected-parity.test 8/8; services-parity.test 5/5. The five "review d5b609bf" tests (24-28) fail on the pre-fix base 58304b9e^ (fe4b4c984c: 23/28, tests 24-28 not ok) and pass on the head.
findings:
- a. pass. tpl-assist.yml:43 ASSIST_DATA_PATHS "src/i18n i18n-source-stamps", committed by assist_finish (tpl-assist.yml:55 git add -- $ASSIST_DATA_PATHS). This matches vitana-v1 (scripts/i18n-stamp-source.mjs:64 STAMP_DIR i18n-source-stamps; I18N-PROPAGATE.yml:261 git add src/i18n i18n-source-stamps). Fan-out from the English pivot: services.json:614 and :627 use --source=en for every locale except en. The en step (:612, :625) reads --source=de, which is correct because de is the source of truth.
- b. pass. tpl-assist.yml:44 I18N_PROVIDER deepseek. No gemini, google or vertex provider in config/delivery or the CI templates; the only "Google" hits are the file path src/hooks/useGoogleConnect.ts (services.json:283). Non-blocking: GitHub I18N-PROPAGATE.yml:146/:207 defaults to gemini, so GitLab deliberately differs from GitHub here, in line with CLAUDE.md AI-27.
- c. pass. services.json:1216 and :1711 add dev-autopilot-impact to the supabase and scripts services. The generated job (platform-delivery.gitlab-ci.yml:909) has rules: changes: services/gateway, scripts, infra, supabase (:954-957), compare_to refs/heads/main (:958).
- d. pass. needs: [] on preview-build:main (v1-delivery.gitlab-ci.yml:1405), build-image:community-app (:1946), and build-image:gateway, :erp-bridge, :kiro-runner and :postgrest-aurora-proxy (platform-delivery.gitlab-ci.yml:3754, :3953, :4065, :4177).
- e. pass, with a non-blocking note. No test passes on zero jobs: pipeline-gen.test.mjs:537 requires at least one build job per file, :518 at least two fan-out loops, :158 more than 5 T1 jobs per repo; affected-parity.test.mjs:22 requires 60 PRs per fixture and :62 compared > 0; services-parity.test.mjs:87 requires at least one filter. Test 27 (:524-531) reads services.json, not the generated rule, but test 4 (pins each generated changes rule to the service list) covers the generated side, and I confirmed it at platform-delivery.gitlab-ci.yml:954-957. Non-blocking: test 25 (:507-512) checks only the I18N_PROVIDER line for "gemini", so a "vertex" or "google" value would slip through. A follow-up could widen it.
- f. pass. queue.mjs scope-check --base 58304b9e^ --head 3a1fffe3f2: "every change is inside its paths" (exit 0). The 15 files of 3a1fffe3f2 are all inside the lane's paths.
- process note (non-blocking): PR #4769 merged on the owner's instruction before this review ("merge 4769", lane log 10:40Z). This entry is the independent review of that merged head.
Next: in-review -> verified with this accept, then verified -> done, one step per PR.

### 2026-11-07T11:00Z · session_01Cp885Gw1CMmPDvDVHc7kw8 · in-review -> verified (closing record, 2 of 3)
Review accepted on head 3a1fffe3f2 by Kiro seat exafyltd (exceptions seat), entry merged in PR #4775 (merge a991a511). Findings a to f pass; two non-blocking notes recorded in the entry.
merge: 3a1fffe3f2  authority: review accept (exafyltd) and owner instruction 2026-11-07 ("merge 4775")

### 2026-11-07T11:05Z · session_01Cp885Gw1CMmPDvDVHc7kw8 · verified -> done (closing record, 3 of 3)
Lane pipelines done on main. Implementation PR #4769 (merge 3a1fffe3), closing steps #4772 and #4777, review accept PR #4775 (merge a991a511).
merge: 3a1fffe3f2  authority: review accept (exafyltd) and owner instruction 2026-11-07 ("merge 4775")
