# Owner outputs (VTID-05555)

Already in this directory: owner read 1 and 2, restore runs 1 to 3 and the pipeline read (see `acceptance.md`, status per AC). The table below lists the outputs still pending. Status as of 2026-11-08T11:15Z: the step 1 pipeline outputs are the only blocker for AC-6.

Waiting for the owner. Each file below is the owner's pasted output, with token values removed before commit.

| File | Step (RUNBOOK) | Status |
|---|---|---|
| `step0-ci-config-commit.txt` | §6 step 0: the commit in `vitana/ci-config` that replaced `platform.gitlab-ci.yml` | not run |
| `step1-gitlab-platform.txt` | §6 step 1: GitLab pipeline of `vitana/vitana-platform` on a `main` commit, each job and result | not run |
| `step1-gitlab-v1.txt` | §6 step 1: GitLab pipeline of `vitana/vitana-v1` on a `main` commit, each job and result | not run |
| `backup-listing.txt` | §7: `aws s3 ls` of `backups/` and `config/` after 02:15 UTC | not run |
| `restore-step-b.txt` | §8 step B: the `backup:`, `doctor:secrets:`, `RESULT-COUNTS:`, `RESULT-MAIN-TIP:`, `RESULT:` lines | not run |
| `restore-step-c.txt` | §8 step C: the `LIVE-COUNTS:` and `LIVE-HAS-TIP:` lines | not run |
| `restore-nginx.txt` | nginx lines of the restored `/etc/gitlab/gitlab.rb` (gitlab-infra review note on `host/gitlab-install.sh:49-53`) | not run |

`github-main-runs.txt` is the GitHub side, read by the session (read only).
