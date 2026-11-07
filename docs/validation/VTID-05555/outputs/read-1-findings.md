# Findings from the first read (2026-11-07T12:34Z)

- **A03 passes.** One backup and one config archive per night at 02:15 UTC on 2026-11-05, -06 and -07 (811.0 MiB last), plus the
  first-configure backup of 2026-11-04. Encryption is pinned by the structure test (lane gitlab-infra).
- **Step 0 is done by the M2 settings sync.** The ci-config hashes equal git `main`: platform.gitlab-ci.yml `598d3ea1…` and
  v1.gitlab-ci.yml `504907d2…` (sha256 of `infra/gitlab-engineering/ci/*.gitlab-ci.yml` on main, github-main-runs.txt). Last ci-config
  commit c44ec2f9b8 at 10:53:24Z.
- **Pipelines do not run since the M2 runner retag (blocker, not this lane's files).** Every job created on 2026-11-07 is `pending` with
  no runner. Both central files ask for tag `vitana-eng` (`ci/platform.gitlab-ci.yml:15`, `ci/v1.gitlab-ci.yml:15`). The settings sync
  retags the M1 runner `vitana-eng-1` to `vitana-legacy` (`settings/gitlab-settings.json:8`), and the runner with tag `vitana-eng` is the
  fleet runner `vitana-eng-fleet` (:9), whose token the sync must store in Secrets Manager. Lane `eng-gitlab-m2/settings-fix`
  (VTID-05591, PR #4780) records that every secret write of the sync failed on the GitLab machine (stdin under systemd, 2026-11-07 10:33Z).
  So no runner serves `vitana-eng`. The last pipeline that ran (v1 #78, 2026-11-06 19:19Z, before the retag) ran on `vitana-eng-1`.
  This waits for settings-fix. No file in this lane's paths can fix it, and the owner is not asked to retag by hand: the next sync would
  revert it (settings/README.md "Never change a setting in the GitLab UI").
- **Difference to record on the first green run: v1 `lint` failed on GitLab** in pipeline #78 (f4eaf3042b; unit-tests and build green).
  GitHub's UNIT-TESTS has no lint job; vitana-v1 lint runs elsewhere on GitHub. To be compared when pipelines run again.
- **A05 not shown yet.** The `RUNNER` lines are missing: the read script's runner line raised an error (the `from bin/rails` trace),
  after the ci-config lines. A glv.sh fix reads tags another way. A05 still needs a job that runs, which waits for the blocker above.

# Read 2 (2026-11-07T17:24Z): the runner blocker is confirmed
- `vitana-eng-1` is online but tagged `vitana-legacy`. `vitana-eng-fleet` carries `vitana-eng` but has never contacted GitLab (no
  `contacted_at`, not online): no fleet machine has registered with its token. Every job since the retag stays pending, as in read 1.
- So A05 and the pipeline comparison wait for the fleet runner to come online (lane eng-gitlab-m2/settings-fix, PR #4780, stores its
  token). Nothing in this lane's paths can change it, and a manual retag would be reverted by the next settings sync.
