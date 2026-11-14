# Findings from restore run 1 (2026-11-07T12:39Z-12:52Z)

- **The restore itself completed.** The latest backup (`1794017725_2026_11_07_19.5.3-ee`) and config archive (`gitlab-config-2026-11-07.tgz`)
  restored on a fresh m6i.xlarge with GitLab `19.5.3-ee.0`; `gitlab:doctor:secrets` reports 0 failures; `RESULT: DONE`. About 11 minutes.
  The scratch machine was removed (step D, nothing left).
- **A04 not proven yet (RUNBOOK defect, fixed under V3).** Step B printed no `RESULT-COUNTS:` or `RESULT-MAIN-TIP:` line. The query ran
  with `2>/dev/null`, so its error was discarded and step B still said `RESULT: DONE`. Step C then had no commit to look up, so
  `LIVE-HAS-TIP: false` compares nothing. Fix in `RUNBOOK.md` §8 and `glv.sh` (identical text): the query runs up to 3 times 60 s apart,
  its stderr is kept, and a missing `RESULT-COUNTS:` fails the step with the last 5 error lines instead of `RESULT: DONE`. Step C now
  prints "no tip to check" for an empty tip, and shows its error instead of discarding it. Live counts: projects 4, groups 1, users 10.
- **nginx (gitlab-infra review note on `host/gitlab-install.sh:49-53`).** The live machine's backed-up `/etc/gitlab/gitlab.rb` carries the
  nested form `gitlab_rails['nginx'][...]` (lines 3-7), the same as `gitlab-install.sh`. The live GitLab answers through the load balancer,
  so the form in use works on the running machine or is ignored without harm there. Whether a fresh build serves port 80 with it is still
  open: this run did not probe port 80 on the scratch machine. `gitlab-install.sh` is outside this lane's paths; any change goes through
  `_plan`.

# Run 2 (2026-11-07T15:14Z, glv.sh 9a501533…)
- The fix of run 1 worked as meant: step B now fails loudly and names the cause instead of printing `RESULT: DONE`.
- Cause: `RESULT: FAIL result query: The file /root/result.rb could not be found`. `gitlab-rails runner` drops to the `git` user, which
  cannot read `/root`. Step C works because it writes its Ruby file to `/tmp`. Fix (V3, RUNBOOK §8 step B and glv.sh): the query file is
  `/tmp/result.rb`, mode 644. The restore itself completed again (doctor:secrets 0 failures, about 11 minutes); the scratch machine was removed.

# Run 3 (2026-11-07T17:08Z, glv.sh 4b66c186…): A04 PASSES
- The 2026-11-07 02:15 UTC backup restored on a fresh m6i.xlarge in about 11 minutes; doctor:secrets 0 failures; `RESULT: DONE`.
- Restored counts `4 1 10` (projects, groups, users) equal the live counts `4 1 10`.
- The restored `vitana/vitana-platform` main tip is `1abd637af3ab16c7be5b1375ec1a585c35e462f3`, and the live project has that commit
  (`LIVE-HAS-TIP: true`). The same commit is GitHub `main` in outputs/github-main-runs.txt, so the mirror, the backup and the restore agree.
- The scratch machine was removed.
