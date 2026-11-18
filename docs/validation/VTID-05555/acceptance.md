# VTID-05555 acceptance (eng-gitlab-m1/gitlab-verify)
Change types: Infrastructure/CI, Tooling/docs.

Lane `gitlab-verify` of plan `eng-gitlab-m1` (late lane), tasks V1-V4 of `.kiro/specs/eng-gitlab-m1/tasks.md`. Builder session
`kiro-exafy-202611071142-d7ed` (seat exafy). The lane records the owner's runs of plan §6 steps 0 to 3 against the live GitLab.
No run is made from a session.

**Status (2026-11-18): A01 to A05 and AC-6 PASS.** A03 and A04 come from the owner's runs of 2026-11-07. AC-6, and the re-reads of A01
and A05, come from 2026-11-18 GET-only reads (no pipeline started, nothing written). The owner's steps stay in `owner-steps.md`.
Structure test on the reviewed head: 26/26 (`outputs/structure-test-12b94e9e93-20261118.txt`).

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
  Status: PASS. Observed 2026-11-04 (`/users/sign_in` 200). Re-read 2026-11-18: the TLS handshake verifies with the default trust store,
  CN gitlab.vitanaland.com, issuer Amazon, valid until 2027-05-20, GET 200.
  TEST: outputs/a01-https-20261118.txt

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
  Status: PASS (read 2026-11-18 with GET requests only, no pipeline started; outputs/step1-gitlab-pipelines-20261118.txt).
  - Step 0: the running files in vitana/ci-config main fe15fa71fd have the same sha256 as git main d8b8a8c5e0 (outputs/step0-ci-config-20261118.txt).
  - vitana-platform d8b8a8c5e0: GitLab pipeline 451 typecheck and gateway-jest 1/4 to 4/4 success. The staging build is manual. GitHub TEST-SUITE 44319701415 success. No difference.
  - vitana-v1 78455457b9: GitLab pipeline 366 unit-tests and build success. `lint` failed; it is `allow_failure` in that central file, which is why the pipeline is `success`. GitHub UNIT-TESTS success. No difference for UNIT-TESTS.
  - Recorded difference, vitana-v1 bbe90b7137: pipeline 441 has 23 of 24 jobs success. `full-suite:mobile-test` fails at `expo install --check` (expo 57.0.25, expected ~57.0.33, plus 7 more packages). GitHub NATIVE-CI 44318699186 skipped the same step by path filter. The cause is vitana-v1 `apps/mobile` dependencies, outside this lane's paths. Follow-up: a new lane `v1-expo-deps` (bring apps/mobile expo packages to the versions `expo install --check` expects) added through `_plan` of the vitana-v1 native plan; it is not built here (V3).
  - A01 and A05 re-read the same day: outputs/a01-https-20261118.txt, outputs/a05-runners-20261118.txt.
  TEST: outputs/step1-gitlab-platform.txt, outputs/step1-gitlab-v1.txt, outputs/github-main-runs.txt

Red to green: this lane adds no test and changes no code (its paths have no test file). The existing tests that pin the files a
V3 fix would touch are green on the base (commands.log).
