---
lane: settings
state: done
next_actor: kiro
depends_on: [gitlab-client]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/settings/**
  - infra/gitlab-engineering/ci/**
  - infra/gitlab-engineering/m2.sh
  - infra/gitlab-engineering/host/ops-install.sh
  - infra/gitlab-engineering/host/units/vitana-settings.service
  - infra/gitlab-engineering/host/units/vitana-settings.timer
  - infra/gitlab-engineering/host/units/vitana-platform-sync.service
  - infra/gitlab-engineering/host/units/vitana-platform-sync.timer
  - infra/gitlab-engineering/terraform/settings.tf
  - scripts/eng/gitlab-settings.mjs
  - scripts/eng/gitlab-settings.test.mjs
  - scripts/eng/free-tier-guard.test.mjs
  - docs/ENGINEERING-PLATFORM-PLAN.md
  - docs/ENGINEERING-PLATFORM-LICENCES.md
  - docs/validation/**
updated: 2026-11-06T22:44Z
claimed_by: kiro-exafy-202611062222-c262
branch: kiro/eng-gitlab-m2/settings
pr: https://github.com/exafyltd/vitana-platform/pull/4711
vtid: VTID-05542
---
# Lane: settings (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.3 and the documentation amendment. Starts when M1 lane gitlab-infra is done. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05542 allocated after policy approval (converged-auto-v1).

### 2026-11-05T12:40Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed. Built in three parts that touched different files: the sync engine (`gitlab-settings.mjs`, its JSON and test), the host files (central CI files, installer, units, IAM, `m2.sh`, the Free-tier guard test) and the two documents. Started from the tip of the M1 branch (8bae0d492d4) while M1 (#4692) waited for its re-review, because `terraform validate` needs M1's `main.tf` in the tree (the lane text says it starts after `gitlab-infra`). This PR was opened after M1 merged, and the branch was rebuilt as one commit on `origin/main`. Tests first (red on an empty implementation: 51 of 52 and 46 of 51). Decisions taken inside the plan (listed for Gate 2): the sync rotates its own admin token under 10 days and `ops-install.sh` mints the first one; on the Free tier a changed branch-protection access level means delete and re-create of `main`; the central CI files are self-contained; the guard skips tests, documents and comments.

### 2026-11-05T16:43Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4711. Evidence regenerated from the final code: 55 + 51 cases (green 106 of 106), 124 + 139 mutations all caught, a full apply on the fake GitLab (66 calls, 36 writes; the second run 0 writes), Terraform `fmt`/`validate` for the new file alone and together with the fleet and monitoring files, `systemd-analyze verify` clean, the whole script set 745 tests with 0 failures on Node 22 and Node 20, 177 documentation links checked, secret scans 0 matches. Ready for a review on the current head. Open for the plan driver (also in the PR): acceptance A2's negative-control jobs live in no lane's paths, so `rehearsal.gitlab-ci.yml` carries only the job `unit`; the seed `package.json` for it is the `rehearsal` lane's.

### 2026-11-05T16:54Z · agent-vitana-lane-reviewer-202611051654-c1dd · review
review: changes
head: 3c36895b18a8b470e9b64fbc806bf13a661675af
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4711
Findings: blocking: scripts/eng/free-tier-guard.test.mjs:399-404 requires infra/gitlab-engineering/ci to hold exactly the three project files and nothing else, but the sync copies every *.yml there and plan agentic-delivery relies on that. PRs #4709 (6 files) and #4705 (tpl-verify.yml) wait for this lane, and neither lane's paths include this test, so their unit check fails deterministically once this merges. Pin only the three named files (they exist and pass lintCi) and accepted names for any other *.yml; limit the PyYAML case at :508 the same way.
Findings: non-blocking: CI on the head was not read in this session (gh pr view and gh pr checks use GraphQL, which is refused here); the caller's 11/11 green was relied on; the land step re-checks.
Findings: non-blocking: depends_on gitlab-client is still in-review on main (closing record #4693); under §7b this PR lands only after that record is on main.
Findings: non-blocking: terraform/settings.tf:43-44 makes the webhook secret read-only and line 6 says the owner puts it there, while tasks.md S4 lets the host role write it. Record the extra owner step under Decisions taken and for scm-webhook and cutover. Not verified against AWS: a secret behind a -?????? grant that does not exist yet may return AccessDenied, which gitlab-settings.mjs:328 treats as an error that stops the whole run; document the dependency on the fleet secret.
Findings: non-blocking: a-red-on-base.txt covers 52 of the 55 final cases (42, 44 and 45 were added later; 17 was renamed). Stub reds are TypeError or SyntaxError, not assertions as the header says. The mutation run covers the added cases; fix the header and counts.
Findings: non-blocking: M1's gitlab-configure.sh:89-90 still writes host/ci-*.yml under the same ci-config names; a re-run of it reverts ci-config until the next sync tick. Note this in the settings README.
Findings: non-blocking: the Node.js row of ENGINEERING-PLATFORM-LICENCES.md (line 64) omits the host install pinned at ops-install.sh:29.
Next: the lane's seat fixes the blocking findings

### 2026-11-05T19:43Z · kiro-exafy-202611021438-cff7 · in-review → executing
Answers to the review of 16:54Z (head 3c36895b18a), one per finding:
- blocking, the guard pinned `ci/` to exactly the three files: accepted. `scripts/eng/free-tier-guard.test.mjs` now requires the three project files and only checks that any other `*.yml` has a name the sync accepts; the PyYAML cross-check reads the three project files. The templates of `pipelines` (#4709) and `verify-on-gitlab` (#4705) can land next to them.
- non-blocking, CI not read by the reviewer: nothing to change.
- non-blocking, `depends_on` gitlab-client: its closing record (#4693) is on main since 19:04 CET.
- non-blocking, the webhook secret is read only and the fleet secret must exist: accepted, recorded under "Decisions taken" in acceptance.md (the owner puts the signing token; `fleet.tf` creates the runner token secret in the same apply, before `m2.sh install` starts the timers). No code change.
- non-blocking, the recorded red covers 52 of 55 cases and the stub reds are not assertions: accepted; the header of `a-red-on-base.txt` and acceptance.md say so.
- non-blocking, a re-run of `gitlab-configure.sh` reverts ci-config: accepted; a note in `settings/README.md`.
- non-blocking, the Node.js licence row: accepted; it names the host install pinned at `ops-install.sh:29`.

### 2026-11-05T19:43Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4711. Fix pushed on a head that merges the current main. Guard test 51 of 51 (PyYAML present), sync engine 55 of 55, the whole script set 872 tests with 0 failures on Node 22 (39 files). Ready for a new review on the current head.

### 2026-11-05T22:30Z · agent-vitana-lane-reviewer-202611052154-0846 · review
review: accept
head: eec9c243136510cea6b1cb3935fdc8892002330d
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4711
Findings: non-blocking: scripts/eng/free-tier-guard.test.mjs:52 cross-lane check (b). #4705 (ab4aedc6) adds ci/tpl-verify.yml. #4709 adds ci/platform-delivery.gitlab-ci.yml, tpl-assist.yml, tpl-checks.yml, tpl-main.yml, tpl-nightly.yml and v1-delivery.gitlab-ci.yml. All seven names pass the sync's rule (CI_FILE_OK) and the guard's rule, and at the current heads no file of either lane under the scan roots trips a rule. At #4709's named head e6490b1c, however, scripts/eng/fixtures/platform-pr-files.json:1033 ('.kiro/specs/mt-track-s-authz/lanes/approvals-auth-v2.md') and :3387 match this approvals rule, because its pattern also matches '/approvals-'. The repository scan (:127) would then fail once both lanes are on main. #4709's head d5b609bf (bdb291a8, 22:03Z) avoids this by writing those slashes as JSON unicode escapes. Require that 'approvals' ends the path segment (no word character, '.' or '-' after it) and add a spec-path near miss, so recorded data needs no escaping; a regenerated fixture would trip the rule again.
Findings: non-blocking: scripts/eng/free-tier-guard.test.mjs:407 the 16:54Z blocking finding is resolved. The test requires the three project files (:404), only those files are linted (CI getter = CI_FILES), and the PyYAML case reads only them (:511-512; it ran in CI). The fix goes one small step past the finding: the name check now skips entries that are not *.yml (filter at :401), which the old loop rejected, and the sync also skips them without a warning (gitlab-settings.mjs:276-278). A .yaml template or a subfolder would therefore be neither synced nor reported. Asserting that every entry is a file with an accepted *.yml name keeps the finding's intent; no file of #4705 or #4709 is such an entry. The PyYAML test title still says 'every file of the folder'.
Findings: non-blocking: infra/gitlab-engineering/terraform/settings.tf:56 check (c), commit eec9c243. The statement grants autoscaling:DescribeAutoScalingGroups and autoscaling:DescribeScalingActivities on '*'. It is read only, and the tests pin it as the only bare-* statement with exactly these two actions. It is not scoped to the fleet group and cannot be, because these List actions take no resource ARN; the role can describe every Auto Scaling group in the engineering account, as :19-21 say. The grant is inside the plan: §3.8 and A1 sample the group, m2.sh rehearse runs rehearse.mjs on this machine over SSM, and §8 limits only the role's writes. It goes past the text of tasks.md S4, and acceptance.md:97 lists it for Gate 2. Line :21 and acceptance.md:97 promise that the rehearsal checks both calls before it writes; that promise belongs in lane rehearsal's acceptance. No lane-log entry records the commit (the 19:43Z in-review entry was written before it).
Findings: non-blocking: docs/validation/VTID-05542/acceptance.md:95 the answer to the 16:54Z webhook finding names the wrong owner step. scripts/aws/setup-gitlab-webhook-secret.sh (lane scm-webhook, branch head cc7adb25, lines 9 and 17-18) reads vitana/engineering/gitlab/webhook-signing-token and copies it to staging, and its header says the settings sync creates that source. This lane only reads the secret (settings.tf:46-50), so no lane creates it and plan §6 step 7 would find no source. No M2 project has a webhook, so M2 behaviour is unaffected. Before Gate 2, name a real creation step (or let the sync create the secret, which S4 allows) and align it with lane scm-webhook.
Findings: non-blocking: docs/validation/VTID-05542/outputs/b-green.txt:7 the evidence was not regenerated after the 16:54Z review. b-green.txt still shows the old names of tests 6, 24 and 25. b-red-on-base, b-mutation-run, b-unit-all*, b-terraform-checks and commands.log (745 tests) were written before e40c31ad and eec9c243. No recorded run covers the guard over the delivery lanes' files; such a run would have shown the fixture match above. CI is the proof for this head. Regenerate the outputs with the next change.
Findings: non-blocking: CI: 10 of 10 checks succeeded on eec9c243, read with gh run view: 42115750855 (Lane scope, pr-gate, Collab handoff), 42115750743, 42115750534, 42115750549, 42115750749, 42115750867 (unit), 42115750751 and 42115750571. The unit run passed the changed tests 598, 606 (PyYAML ran), 616 and 617. The runs used the merge ref f575438d (main 27de7a98 plus this head). Main is now 0f45367b (#4697, #4718 and #4689 added). Those commits touch no governance path, no protected gate file and nothing in this lane's paths. Their new files under the scan roots trip no rule (gitlab-land.mjs matches only on comment line 1), and the units and timer tests use fixed lists.
Findings: non-blocking: the other 16:54Z findings are answered, and the answers hold. gitlab-client is done on main. The a-red-on-base.txt header and acceptance.md describe the red run accurately. settings/README.md has the gitlab-configure.sh note. The Node.js row cites ops-install.sh:29 (NODE_VERSION=20.20.2). The update merge 800d8114 is clean: its diff from main ec7f45cc holds only lane files, and no lane file differs from e40c31ad.
Findings: non-blocking: check (d), independence and scope. The evidence shows no write to GitLab, AWS or any other live system. The 'Not done by rule' section of commands.log stands, the fix commits add no output, and both secret scans found 0 matches. The phrase 'found after a 75-minute run' in eec9c243's message refers to the owner's future run (acceptance.md:97). The caller kiro-exafy-202611041929-802c is not in the lane log, and its only commit here is the 82f7dfbb review entry. Every changed file is inside the lane's paths or is the lane's own file, and none is a protected gate file.
Next: the land step merges under §7b. It updates the branch to main 0f45367b (main's commits since ec7f45cc touch no governance path or protected gate file; land-guard.mjs decides whether this accept carries over), confirms with land-guard.mjs checks that every check is green on that head, then lands. #4705 and #4709 land after this lane is done (plan agentic-delivery §9). The _plan holder carries the webhook-secret owner step and the approvals-rule fix into handoff.md for Gate 2.

### 2026-11-06T22:44Z · kiro-exafy-202611062222-c262 · in-review → verified
Closing record written by the plan driver kiro-exafy-202611062222-c262, which took over this lane's stale claim (holder silent > 24 h).
Review: the reviewer-agent accept by agent-vitana-lane-reviewer-202611052154-0846 on head eec9c243136510cea6b1cb3935fdc8892002330d is in this log.
PR https://github.com/exafyltd/vitana-platform/pull/4711 merged at 2026-11-05T22:40:39Z by DraganOffice (the gh identity of the plan driver's review desk) with head d28e8c960afce87939e2633016caaca89b1ac475.
`land-guard.mjs review --gh exafyltd/vitana-platform --repo . --pr 4711 --reviewed-head eec9c243136510cea6b1cb3935fdc8892002330d` (run 2026-11-06T22:44Z): ok, only lane-file entries and clean merges of main after the reviewed head, so the accept counted for the merged head.
Checks on the merged head (REST check-runs read, 2026-11-06T22:44Z): 12 of 12 completed/success; none red or missing.

### 2026-11-06T22:44Z · kiro-exafy-202611062222-c262 · verified → done
merge: 0e5a74a72a8fe26785df3133f4133b3e99b97efd
authority: §7b PM rule (plan driver review desk; accept current on the merged head, checks green).
Gap: the lane said in-review, not verified, when it merged, and no merge line was written at the time; this entry records both.
Next: none; the lane is done.
