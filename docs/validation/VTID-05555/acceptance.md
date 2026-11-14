# VTID-05555 acceptance (eng-gitlab-m1/gitlab-verify)
Change types: Infrastructure/CI, Tooling/docs.

Lane `gitlab-verify` of plan `eng-gitlab-m1` (late lane), tasks V1-V4 of `.kiro/specs/eng-gitlab-m1/tasks.md`. Builder session
`kiro-exafy-202611071142-d7ed` (seat exafy). The lane records the owner's runs of plan §6 steps 0 to 3 against the live GitLab.
No run is made from a session.

**Status: waiting for the owner.** Lane state "the owner has not run a step yet (the lane waits)". The owner's steps are in
`owner-steps.md`. Every `AC-` entry below that needs an owner output is `PENDING` until that output is in `outputs/`.

Outcome: the running GitLab does what plan §9 says (A01-A05), plus the first green pipelines of both mirrored projects next to
GitHub's results.

States: owner has not run a step (now); a pipeline fails on GitLab and passes on GitHub (recorded as a difference, fixed under V3);
the restore fails (RUNBOOK fixed under V3); the backup bucket is empty after 02:15 UTC (finding for `backup.sh`, through `_plan`).

Surfaces: `docs/validation/VTID-05555/`; `RUNBOOK.md` §8 steps B and C changed under V3 (restore run 1 showed the result query's
output discarded); `host/ci-*.yml` unchanged.

Locales: n/a. Accessibility: n/a.

Contract: no session run against the live GitLab or AWS; owner-pasted outputs only; token values removed before commit; GitHub's
side read with `gh api` (read only).

Staging proof: not verified on staging: no product path changes. The evidence is the owner's runs against the live GitLab.

AC-1 (A01) — GitLab answers over HTTPS with a valid certificate on `gitlab.vitanaland.com`
  Status: observed 2026-11-04 (`/users/sign_in` 200, plan §6 "Done"). Confirmed again by step 1 (pipeline pages load over HTTPS).
  TEST: outputs/step1-gitlab-platform.txt (PENDING)

AC-2 (A02) — the infrastructure is created by Terraform and can be rebuilt from git
  Status: files on main through lane gitlab-infra (VTID-05544, merge a8220f1059); structure test green (26/26, commands.log).
  The restore on a fresh machine (step 2) is the rebuild evidence for the GitLab config; the nginx lines are compared with
  `host/gitlab-install.sh:49-53` (gitlab-infra review note).
  TEST: scripts/eng/gitlab-m1-structure.test.mjs; outputs/restore-1-20261107T1239Z.txt (nginx lines 3-7: nested form, as gitlab-install.sh)

AC-3 (A03) — storage is encrypted and a nightly backup exists in the backup bucket
  Status: PASS. Nightly backups and config archives 2026-11-05, -06, -07 at 02:15 UTC (outputs/read-20261107T1234Z.txt); encryption pinned
  by the structure test.
  TEST: outputs/read-20261107T1234Z.txt, outputs/read-1-findings.md

AC-4 (A04) — a restore on a scratch machine reproduces the project count and one commit hash
  Status: PASS (restore run 3, 2026-11-07T17:08Z). Backup 1794017725_2026_11_07_19.5.3-ee restored, doctor:secrets 0 failures;
  RESULT-COUNTS 4 1 10 = LIVE-COUNTS 4 1 10; restored main tip 1abd637af3 is in the live project (LIVE-HAS-TIP: true).
  Runs 1 and 2 failed on two RUNBOOK §8 defects, both fixed under V3 (outputs/restore-1-findings.md).
  TEST: outputs/restore-3-20261107T1708Z.txt, outputs/restore-1-findings.md

AC-5 (A05) — the runner is registered and runs jobs
  Status: PASS. Fleet runner vitana-eng-fleet registered and verified 2026-11-07T18:05Z; vitana-v1 pipeline 136 ran all three jobs on it,
  vitana-platform typecheck ran on it (pipelines 141-143). The M1 runner vitana-eng-1 is online under tag vitana-legacy.
  TEST: outputs/pipelines-20261107T1835Z.txt, outputs/read-1-findings.md

AC-6 (pipelines) — first green pipelines on both mirrored projects, each job next to GitHub's result for the same main commit
  Status: GitHub side recorded (outputs/github-main-runs.txt, both green). Step 0 done by the M2 settings sync (ci-config hashes equal
  git main). GitLab side BLOCKED: since the M2 runner retag no runner serves tag vitana-eng, waiting for eng-gitlab-m2/settings-fix
  (PR #4780); outputs/read-1-findings.md.
  TEST: outputs/step1-gitlab-platform.txt, outputs/step1-gitlab-v1.txt, outputs/github-main-runs.txt

Red to green: this lane adds no test and changes no code (its paths have no test file). The existing tests that pin the files a
V3 fix would touch are green on the base (commands.log).
