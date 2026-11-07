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

# Session diagnosis with the owner's 1-hour read-only engineering credentials (2026-11-07 ~18:00Z)
- `vitana/engineering/gitlab/fleet-runner-token` was written at 17:36:20Z (DescribeSecret LastChangedDate): the settings-fix-v2 fix works.
- Root cause of the offline fleet runner: the fleet manager (i-05bf5e08fa12864a9, started 2026-11-06T21:55Z) never installed the runner.
  `/var/log/vitana-bootstrap.log` ends with `gitlab-runner : Depends: gitlab-runner-helper-images (= 19.5.2-1) but 19.5.3-1 is to be
  installed` and `E: Unable to correct problems, you have held broken packages.`; `/etc/gitlab-runner/` does not exist; gitlab-runner is
  inactive. `host/fleet-manager-install.sh:112` (and `host/runner-install.sh:26`) pin `gitlab-runner=$RUNNER_VERSION` (19.5.2-1) but not
  `gitlab-runner-helper-images`, so apt takes the newest helper (19.5.3-1) and refuses. 19.5.2-1 of the helper is in the repository.
- Fix in git: pin both packages to `$RUNNER_VERSION` in both installers (+ fleet-structure.test.mjs:614). Those files belong to the done
  lane eng-gitlab-m2/fleet, so the fix is a new lane through `_plan` of eng-gitlab-m2. On the running manager the owner re-runs the
  installer with the helper pinned (a live write; a session never does it).

# First pipelines on the fleet runner (2026-11-07T18:35Z, pipelines-20261107T1835Z.txt)
- **vitana-v1 pipeline 136 on f837a9927d: unit-tests success (471 s), build success (206 s), lint failed (173 s)**, all on vitana-eng-fleet.
  GitHub on the same commit: Vitest (jsdom), Edge data client and Realtime helper success; GitHub's lint is "ESLint native override
  (apps/mobile, packages) + i18n rule tests" (success). Difference recorded: GitLab's `lint` job runs the whole `npm run lint`
  (host/ci-v1.yml), which GitHub does not run as a required check. Same result as GitLab pipeline 78 (2026-11-06). V3: the job should
  run what GitHub runs; `host/ci-v1.yml` is in this lane's paths but the running file comes from `ci/v1.gitlab-ci.yml` (settings sync),
  which is not, so the fix is in eng-gitlab-m2.
- **vitana-platform: typecheck passes on GitLab** (pipelines 141, 142, 143 on 59a9045091, 4b493616bc, 5e5aa4859d): premise P10's
  `pnpm install` failure is fixed by the corrected central file. **gateway-jest 1-4/4 never finish**: with one fleet machine
  (autoscaling group MaxSize 1) the five jobs run one after another, and each new `main` push about every 5 minutes cancels the running
  pipeline (interruptible jobs). The group needs more than one machine: MaxSize 1 against `fleet_max_instances` (Terraform) and an
  EC2 Standard vCPU quota of 32 (14 in use by the GitLab, runner and manager machines plus one job machine).

# Fleet size and the first full platform runs (2026-11-07 ~20:00Z, owner instruction to run the AWS work)
- Writes made with a 1-hour role session (ReadOnlyAccess + ssm:SendCommand + autoscaling:UpdateAutoScalingGroup +
  servicequotas:RequestServiceQuotaIncrease), engineering account 841276716213 only:
  - EC2 quota requests to 100 vCPUs: Running On-Demand Standard (7806974cf60c4cd3a7d6d13954ebe329Q9uB6mzj) and All Standard Spot
    (8c5cb85a110d41c084de4cafe36a9600n9xr8xWh), both PENDING at 19:55Z.
  - Auto Scaling group vitana-eng-fleet MaxSize 1 -> 5 (32 vCPUs allow five 4-vCPU job machines beside the three fixed machines).
  - Fleet manager: /etc/vitana/env FLEET_MAX_INSTANCES=1 -> 5 (backup env.bak-20261107), installer re-run (SSM 4e185592-...):
    config.toml concurrent = 5, max_instances = 5, runner verified 19:56:26Z.
  - Not changed: ~/vitana-eng/terraform/terraform.tfvars lives only in the owner's CloudShell; until it says fleet_max_instances = 5
    the next terraform apply resets MaxSize to 1.
- With 5 machines the platform pipeline finishes (154 on 67c29e13db, 155 on 69d046b016): typecheck green; gateway-jest 1-4/4 red with
  9 + 3 + 11 + 5 failed tests (8,903 + 7,216 + 7,003 + 6,446 passed). Main cause: `jq: not found` 22 times. The job image
  public.ecr.aws/docker/library/node:20-bookworm has no jq, and GitHub's ubuntu-latest has it; the failing suites shell out to jq
  (ALERT workflow steps, env_overrides jq block, deploy-secret wiring, morning-report rows). Fix: install jq in the `.gateway` jobs of
  `infra/gitlab-engineering/ci/platform.gitlab-ci.yml` (eng-gitlab-m2 file, through `_plan`). Recorded as a GitLab/GitHub difference,
  not hidden.
