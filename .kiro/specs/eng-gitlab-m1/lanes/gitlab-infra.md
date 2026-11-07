---
lane: gitlab-infra
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/**
  - scripts/eng/gitlab-m1-structure.test.mjs
  - docs/validation/**
claimed_by: kiro-exafy-202611062222-c262
branch: kiro/eng-gitlab-m1/gitlab-infra
pr: https://github.com/exafyltd/vitana-platform/pull/4692
updated: 2026-11-06T22:45Z
vtid: VTID-05544
---
# Lane: gitlab-infra (repo vitana-platform)
Tasks in `tasks.md`. Commits the running bundle (plan §4). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T18:22Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.
### 2026-11-04T19:02Z · kiro-exafy-202611021438-cff7 · note
Plan rewritten to describe what runs. The second lane (`gitlab-ci`) is dropped: the central CI files are part of the bundle.

### 2026-11-04T20:33Z · ci-plan-spar · ready (VTID allocated)
VTID-05544 allocated after policy approval (converged-auto-v1).

### 2026-11-05T08:28Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed; test, bundle and evidence on branch kiro/eng-gitlab-m1/gitlab-infra. Tests first (red on base: the bundle folder is absent and
26 of 26 cases fail; 26 of 26 also fail on an empty bundle), then the bundle as the owner ran it (v6) with the one planned correction in
host/ci-platform.yml, RUNBOOK.md and the evidence. Decisions taken inside the plan (listed for Gate 2): the Terraform lock file is not
committed (one made on one platform breaks init on another); files keep mode 0644 as in the archive; the test was tightened after its first
mutation run (138 changes, 6 survivors, now 0 not caught). Owner steps 0 to 3 of plan section 6 stay open and cannot be done from this session.

### 2026-11-05T08:31Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4692 (head: see the PR). Evidence regenerated from the final files: 26 cases (red on base 26 of 26,
red on an empty bundle 26 of 26, green 26 of 26), a mutation run of 138 changes (0 not caught), the whole script set 639 tests with 0 failures on
Node 22 and Node 20, terraform validate, the gateway type check both ways, the restore script's control flow with stubs, the cost estimate.
The reviewer agent `vitana-lane-reviewer` is not in this Kiro Web runtime's agent registry; the accept for the previous lane came from another
runtime, and this lane waits for its accept on the current head. Open for the owner (plan section 6, steps 0 to 3): paste the corrected
platform.gitlab-ci.yml into GitLab project vitana/ci-config, read the first pipelines, run the restore test, list the backup bucket.

### 2026-11-05T09:30Z · agent-vitana-lane-reviewer-202611050930-a050 · review
review: changes
head: 3b1191cec234d42e9db63b4a61aa243e03c8cc3a
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4692
Findings:
- [blocking] docs/validation/VTID-05544/acceptance.md:51: the lane's acceptance needs the owner's runs of plan §6 steps 0-3 as lane evidence. Sources: tasks.md I4; Outcome 'green pipelines on our own runner'; Staging proof 'the owner's runs of plan §6 steps 1 to 3'; plan §5; plan §6 step 4 comes after steps 0-3, and step 1 says the lane fixes the central CI file (RUNBOOK.md:162). These runs are listed as open, and acceptance.md:3 drops the pipeline clause. No step needs the merge. Add the output, or change the plan through _plan.
- [non-blocking] host/gitlab-configure.sh:55 logs the runner-creation response, including the glrt- token, if put-secret-value at :51 fails. It did not trigger on 2026-11-04. Add it to the acceptance.md:49 deferred list. The process-list exposure is wider than mirror.sh:37 (mirror.sh:23, :26-30; gitlab-configure.sh:12, :28; runner-install.sh:43; runner-fix.sh:20; gitlab-install.sh:37; setup.sh:298).
- [non-blocking] gitlab-m1-structure.test.mjs:141: the IAM wildcard check reads only aws_iam_policy_document blocks. An inline jsonencode or heredoc role policy, or a partial wildcard, would pass.
- [non-blocking] gitlab-m1-structure.test.mjs:114, 223, 238: exact-text pins (fmt alignment, prompt wording) fail safe but go red on harmless reformatting.
- [non-blocking] RUNBOOK.md:32: there is no step to get the git copy into CloudShell for a rebuild. state.env is written next to setup.sh.
- [non-blocking] RUNBOOK.md:305-306: 'cannot touch the backup bucket' overstates it, because the scratch machine has the vitana-eng-gitlab role. Steps B and C rely on BUCKET and ACCOUNT_ID from earlier sections.
- [non-blocking] Not confirmed independently: CI (GraphQL refused; the caller's REST read says 11/11 green), and byte identity with bundle v6 (the archive is not in git).
Next: the lane's seat fixes the blocking finding. The owner runs plan §6 steps 0-3 from RUNBOOK §6-§8 on the PR branch. The builder adds the pasted output, the GitLab-vs-GitHub comparison and any host/ci-platform.yml fix to docs/validation/VTID-05544/. Then a new review runs on the new head. Checklist items 2 and 4-9 passed on this head: paths in scope; red on base 26/26 and on an empty bundle 26/26; green 26/26; 138 of 138 mutations caught; no test weakened; no live write; merging deploys nothing; no protected gate file; no secret committed. Item 3 rests on the caller's REST read.

### 2026-11-05T10:25Z · kiro-exafy-202611021438-cff7 · in-review → executing
The review of 2026-11-05T09:30Z (head 3b1191cec234d42e9db63b4a61aa243e03c8cc3a) is `changes`. One answer per finding:
- [blocking] the owner's runs of plan §6 steps 0 to 3 as lane evidence: accepted, in the second form the reviewer offered, a change through `_plan`.
  Late lane `gitlab-verify` (plan PR https://github.com/exafyltd/vitana-platform/pull/4695, `depends_on: [gitlab-infra]`) takes that evidence and the
  "green pipelines" clause of the Outcome; the plan is `done` only when both lanes are. acceptance.md says so in its Outcome and Decisions. The sparred
  plan text is unchanged. This lane's review is asked again after that PR is on `main`.
- [non-blocking] `host/gitlab-configure.sh:55` logs the runner-creation answer (the `glrt-` token) when `put-secret-value` fails, and the wider
  process-list exposure: accepted; both are on the deferred list in acceptance.md (Decisions), with the eight call sites. The files keep the behaviour that ran.
- [non-blocking] case 8 read only `aws_iam_policy_document` blocks: accepted. It now refuses a `*` inside any action or resource string (except the
  TLS-only deny and the bucket's object ARN), requires every `policy` and `assume_role_policy` to be a data document's JSON, and refuses an
  `aws_iam_policy` resource; five new changes exercise it (143 changes, 143 caught).
- [non-blocking] exact-text pins (fmt alignment of the secret names, the wording of the two token prompts): accepted, relaxed to patterns that still require a hidden read.
- [non-blocking] RUNBOOK.md:32 no way to get the git copy into CloudShell: accepted, a paragraph in section 2 (what `setup.sh` finds again without a `state.env`).
- [non-blocking] RUNBOOK.md:305-306 and the variables of steps B and C: accepted, the wording now says the scratch machine's role can read and write the
  bucket and nothing on it does by itself; section 8 sets `BUCKET` and says where `TIP` comes from.
- [not confirmed independently] byte identity with bundle v6: `outputs/owner-cloudshell-block-v6.txt` is the block the owner pasted, byte for byte, and
  `outputs/compare-with-v6.sh <repository root>` decodes it, checks the hash the block checks, and compares every file; its output is
  `outputs/diff-vs-running-bundle.txt`. CI: all checks green on 3b1191cec234 by the REST read.

### 2026-11-05T10:25Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4692. `main` merged into the branch (29b639da4bf). Evidence regenerated from the final files: 26 cases (red on
base 26 of 26, on an empty bundle 26 of 26, green 26 of 26), a mutation run of 143 changes (0 not caught), the whole script set 639 tests with 0 failures on
Node 22 and Node 20, the comparison with the archive, a secret scan of 34 files. Ready for a new review on the current head once plan PR #4695 is on `main`.

### 2026-11-05T15:09Z · agent-vitana-lane-reviewer-202611051509-916c · review
review: accept
head: edb596fbe0732ffb1501538f5becbb7809a55088
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4692
Findings:
- [non-blocking] infra/gitlab-engineering/host/gitlab-install.sh:49-53: gitlab.rb sets the NGINX keys as gitlab_rails['nginx'][...], but as far as this reviewer knows the Linux package reads only top-level nginx[...]. If 19.5.3 ignores the nested form, a fresh build serves nothing on port 80, gitlab-configure.sh:14-21 stops at 'GitLab not ready', and the rebuild from git (A02) fails. The running machine works, so either 19.5.3 accepts this form or its gitlab.rb differs from this file. Case 20 (gitlab-m1-structure.test.mjs:292-293) pins the nested form. gitlab-verify can compare the nginx lines of the restored /etc/gitlab/gitlab.rb (RUNBOOK §8 step B). A fix to gitlab-install.sh and case 20 goes through _plan.
- [non-blocking] docs/validation/VTID-05544/acceptance.md:51: the runner-creation log line is gitlab-configure.sh:55, not :56. The deferred list misses gitlab-configure.sh:26 and :31 (bootstrap token in a curl header), :51 (runner token to put-secret-value) and gitlab-install.sh:68 (root password to put-secret-value).
- [non-blocking] scripts/eng/gitlab-m1-structure.test.mjs:163: the attached-policy check reads only quoted policy_arn values. A managed_policy_arns list or a data.aws_iam_policy reference could attach, for example, AmazonS3FullAccess while every case stays green.
- [non-blocking] Not confirmed independently: CI (GraphQL refused and gh api not allowed; the caller's REST read says 11/11 success at 15:07:46Z), the PR body, and byte identity with bundle v6 (compare-with-v6.sh cannot be run here). Confirmed with git: the PR's own diff is blob-identical at 8bae0d49 and edb596fb, and the update-branch merge brings in only main's 29b639da..ce38b681.
Next: the land step merges under §7b. For lane gitlab-verify: record the nginx lines of the restored gitlab.rb next to host/gitlab-install.sh:49-53 (first finding). Checklist results on this head:
- Item 1: met against tasks.md on main. The owner-run evidence and the green-pipeline clause moved to gitlab-verify (VTID-05555) through #4695 (ce38b681), which was the second option the 09:30Z review offered. The six non-blocking 09:30Z findings are answered in the test, the RUNBOOK and the evidence, with the gaps listed above.
- Item 2: all 35 files are in the lane's paths.
- Item 3: rests on the caller's REST read.
- Item 4: red on base 26/26 (one ENOENT per case), red on an empty bundle 26/26 by assertion, green 26/26, and 143 of 143 mutations caught.
- Items 5-9: pass. No test weakened, no live write, no spoken string, no UI, no protected gate file.
- Item 10: the plan §3 values match. Only host/ci-platform.yml differs from v6, and only by the planned install steps. No secret value is in git or in the Terraform outputs. No workflow file is in the diff, and no workflow on main triggers on these paths. The Tooling/docs links resolve. The Infrastructure/CI "workflow run is linked" check is carried by gitlab-verify (the GitLab pipeline runs).

### 2026-11-06T22:45Z · kiro-exafy-202611062222-c262 · in-review → verified
Closing record written by the plan driver kiro-exafy-202611062222-c262, which took over this lane's stale claim (holder silent > 24 h).
Review: the reviewer-agent accept by agent-vitana-lane-reviewer-202611051509-916c on head edb596fbe0732ffb1501538f5becbb7809a55088 is in this log.
PR https://github.com/exafyltd/vitana-platform/pull/4692 merged at 2026-11-05T15:45:03Z by DraganOffice (the gh identity of the plan driver's review desk) with head 6378b2c69ce0f62dc616e528f94ae2894b46714f.
`land-guard.mjs review --gh exafyltd/vitana-platform --repo . --pr 4692 --reviewed-head edb596fbe0732ffb1501538f5becbb7809a55088` (run 2026-11-06T22:45Z): ok, only lane-file entries and clean merges of main after the reviewed head, so the accept counted for the merged head.
Checks on the merged head (REST check-runs read, 2026-11-06T22:45Z): 12 of 12 completed/success; none red or missing.

### 2026-11-06T22:45Z · kiro-exafy-202611062222-c262 · verified → done
merge: a8220f105957ffff0d6a5287e229c0cbd01c371b
authority: §7b PM rule (plan driver review desk; accept current on the merged head, checks green).
Gap: the lane said in-review, not verified, when it merged, and no merge line was written at the time; this entry records both.
Next: none; the lane is done.
