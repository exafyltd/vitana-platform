# VTID-05555: the owner's steps (task V1)

Plan `eng-gitlab-m1` §6 steps 0 to 3, as `infra/gitlab-engineering/RUNBOOK.md` gives them on `main`. None of these is a routine step:
each runs against the live GitLab or the engineering AWS account, so a session never runs them (lane contract). Paste each output
back into the session or into `outputs/` (remove token values first).

0. **Put the corrected platform CI file into GitLab** (RUNBOOK §6, step 0). Signed in as `root`: project `vitana/ci-config`, file
   `platform.gitlab-ci.yml`, Edit, replace everything with the YAML block of RUNBOOK §6 (identical to `host/ci-platform.yml`; a
   test pins it), commit to `main`. Do not re-run the configure script afterwards (it would restore the old host copy).
   Paste: the commit SHA and time shown in `vitana/ci-config`.
1. **First green pipelines** (RUNBOOK §6, step 1). In `vitana/vitana-platform` and `vitana/vitana-v1`: CI/CD → Pipelines → Run
   pipeline on `main` (or the one the mirror started after step 0). Paste for each: the pipeline URL, the `main` commit SHA, and
   every job with its result and duration. The session puts GitHub's result for the same commit next to it.
2. **Restore test** (RUNBOOK §8, steps A to D; about an hour). Paste the lines that §8 names: `backup:`, `doctor:secrets:`,
   `RESULT-COUNTS:`, `RESULT-MAIN-TIP:`, `RESULT: DONE <id>` (or the `RESULT: FAIL` line), then step C's `LIVE-COUNTS:` and
   `LIVE-HAS-TIP:`. Before step D (removing the scratch machine), also paste the nginx lines of the restored config, read on the
   scratch machine through Systems Manager: `grep -n nginx /etc/gitlab/gitlab.rb`.
3. **Backup listing** (RUNBOOK §7), after 02:15 UTC: paste the output of
   `aws s3 ls s3://$BUCKET/backups/ --human-readable` and `aws s3 ls s3://$BUCKET/config/ --human-readable`.

If a pipeline job or a RUNBOOK command fails, paste the failing output too: the lane fixes `host/ci-platform.yml`, `host/ci-v1.yml`
or `RUNBOOK.md` in its PR (task V3), never by loosening a check.

## CloudShell script (owner, 2026-11-07: "I'm only working with Cloud Shell AWS")
`glv.sh` in this folder does every step from CloudShell: `bash glv.sh read` (A03 backup listing, A05 runner and the latest `main`
pipelines of both projects, the hashes of the ci-config files, read only) and `bash glv.sh restore` (RUNBOOK §8 steps A to D,
including the nginx lines). Step 0 is no longer a paste: the M2 settings sync (lane `settings`, done) writes
`infra/gitlab-engineering/ci/*.yml` to `vitana/ci-config` every 10 minutes, so `read` checks the hashes against git instead.
