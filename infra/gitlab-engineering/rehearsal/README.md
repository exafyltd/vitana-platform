# The rehearsal (plan eng-gitlab-m2, section 3.8)

One command shows whether the whole path works on a scratch project, before any real repository depends on it: twelve agents open merge requests in
parallel, the fleet grows from zero and returns to zero, the merge bot lands the merge requests one at a time, and `main` ends up right. Its report is
the proof of acceptance A1, A2, A3, A4 and A8 of the plan (section 9).

```
bash ~/vitana-eng/m2.sh rehearse                 # the owner: runs the next line on the GitLab machine and prints the report
node scripts/eng/rehearse.mjs --project rehearsal --agents 12 [--dry-run]     # what runs there, as root, from /opt/vitana/platform
```

It takes about an hour (seed 10 minutes, then about 4 minutes per landing). `--dry-run` runs every check, reads GitLab and prints the plan, and writes
nothing. Exit code: **0** every acceptance this run checked held; **1** one failed, was not proven, or the run could not finish (the report says
which); **2** a usage mistake, or a refusal to start: a safety check failed or could not be made, and **nothing was written**.

## Before the first run

1. The settings sync has run (`m2.sh settings` or its timer): the project `vitana/rehearsal`, its seven accounts and their tokens exist, and
   `m2.sh status` is clean. The bot timer `vitana-land` is active.
2. The fleet manager has started the fleet runner (its token secret holds a `glrt-` value).
3. **The role of the GitLab machine must be allowed to read the fleet group.** Terraform today gives it Secrets Manager, S3 and KMS only. Without
   the two actions below the report cannot prove A1: it says `NOT PROVEN` and names them (everything else is still decided). Add this to the
   Terraform of the GitLab machine, next to `settings.tf` (it is outside the paths of the lane `rehearsal`, so a follow-up change makes it):

```hcl
data "aws_iam_policy_document" "rehearsal" {
  statement {
    sid       = "ReadTheFleetGroupForTheRehearsal"
    actions   = ["autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeScalingActivities"]
    resources = ["*"] # Describe* actions cannot be limited to one group
  }
}

resource "aws_iam_role_policy" "rehearsal" {
  name   = "rehearsal"
  role   = aws_iam_role.gitlab.id
  policy = data.aws_iam_policy_document.rehearsal.json
}
```

## What it does

| Step | What |
|---|---|
| Checks | The project must be marked `rehearsal: true`, `native`, `landing: true` and without a webhook in `gitlab-settings.json`, and the live project must agree: no webhook, no mirror, `main` push **No one**, merge Maintainers, no force push. Every token must belong to the account it is stored for. No open merge request may be from anywhere but an earlier rehearsal. `CLAUDE.md` must be a protected gate file under the rules of this machine. |
| Hygiene | Merge requests left open by an earlier run (branch `rehearsal/…`) are closed. |
| Seed | If `main` does not hold `seed/` (this folder) it is put there by a merge request of lane `rehearsal/seed`: built by a seat, accepted by `agent-reviewer`, landed by the bot like any other. `main` takes no push. A current seed is left alone; an outdated file is updated through the same route; the lane files, which runs grow, are created once and never rewritten. |
| Wave 1 | Five control merge requests (they are the oldest, so the bot reads them first), then 12 lane merge requests, round robin over `agent-kiro-exafy`, `-exafyltd`, `-jtadic`, `-hotmail`. One commit each, new files only, named by run and lane, so no two merge requests touch the same path. |
| Wave 2 | When every first job has started (or after 8 minutes): `agent-reviewer` commits the accept on every lane and on three controls, so up to 24 pipelines are in flight at once. The controls get their faults. |
| Landing | The bot lands the lanes. The rehearsal samples the ASG every 15 seconds, waits for the jobs to settle, closes the controls and deletes their branches, then waits for the group to reach 0 machines. |
| Reading | Jobs, job traces, commits on `main`, the bot's comments, protection, members, token expiry, `gitlab-settings.mjs check`, the ASG activity history. |

The five controls (acceptance A4) and the reason the bot must give for each:

| Control | The fault | Reason |
|---|---|---|
| `ctl-no-review` | no review at all | `no_review` |
| `ctl-stale-review` | an accept of an older head; the builder changed code after it | `review_stale` |
| `ctl-builder-accept` | an accept written (same words) by the builder's account, not pushed by `agent-reviewer` | `review_forged` |
| `ctl-red-job` | a reviewed merge request whose required job `unit` fails | `checks_failed` |
| `ctl-protected-file` | a reviewed merge request that adds `CLAUDE.md` | `protected_gate_file` |

## The seed (`seed/`)

`manifest.json` says what goes where. Everything in the folder is copied to the same path, except `spec/`, which becomes `.kiro/specs/rehearsal/`
(twelve lane files, the lane `seed`, a plan, a handoff). The collab tooling (`queue.mjs`, `land-guard.mjs`, `protected-gate-files.json`) is copied
from `main` of the platform checkout the script runs from, to `tools/collab/`. It must not go to `scripts/collab/`: those paths are protected gate
files and the bot would refuse the seed. `rehearsal.config.json` is generated (the private address of the GitLab machine).

`npm test` of the seed is the required job `unit` (`ci/rehearsal.gitlab-ci.yml`): `scripts/ci-test.mjs` runs the tests with no install, then prints
the three negative controls of A2, one line each, which the rehearsal reads from the job trace:

| Line | PASS means |
|---|---|
| `NEGCTL imds PASS` | the instance metadata service (169.254.169.254) gives a job container no answer, to a token request or a plain read |
| `NEGCTL gitlab-host PASS` | the private address of the GitLab machine accepts no connection on 22, 80, 443 or 8080 from a job |
| `NEGCTL aws-env PASS` | no environment variable of the job starts with `AWS_` |

A control that fails prints `FAIL` and does not fail the job: the rest of the rehearsal still runs and the report decides.

## Reading the report

`RESULT: PASS` needs all of A1, A2, A3, A4 and A8 to be PASS and the run to have finished. A verdict is `FAIL` when a check found the opposite of the claim and
`NOT PROVEN` when it could not be made (unreadable ASG, unreadable traces, a token that GitLab did not answer for). Under `PROBLEMS AND NOTES` the
report names jobs that never finished, the machine launches that AWS refused (with its message), and every lane that did not land with each reason the
bot gave.

| Symptom | Usually |
|---|---|
| `STOPPED in seed … did not land within 25 minutes` | the bot timer is off or failing (`journalctl -u vitana-land`), or the first pipeline never got a machine |
| `STOPPED in seed … no push event of agent-reviewer` | this GitLab does not record API commits as pushes; the review commit has to be pushed with git (a follow-up change of this script) |
| `A1 … NOT PROVEN … autoscaling:Describe…` | the role of the GitLab machine lacks the two actions above |
| `A1 … peak fleet size < 20` | machines are slow to start, jobs are cancelled by newer pushes, or the fleet maximum is below 20 |
| `A2 … FAIL` for `imds` | the launch template allows a hop limit above 1, or the job runs with host networking |
| `A2 … FAIL` for `gitlab-host` | the security group of the GitLab machine admits the job group |
| `A3 … settings check exit 3` | a setting was changed by hand; `m2.sh settings` puts it back |
| `A4 … no refusal with reason …` | the bot refused for another reason, or not at all: read what it said under `BOT REFUSALS` |

## What it writes, and where

Only the project `vitana/rehearsal`, with four calls: `POST …/repository/commits`, `POST …/merge_requests`, `PUT …/merge_requests/:iid` (close only) and
`DELETE …/repository/branches/:name`. It never writes `main` (nobody can), never touches another project, a runner, a user, a setting or a secret, and
never calls production, the gateway or Supabase. AWS is read only: the seven token secrets `vitana/engineering/gitlab/agents/<username>` and the
Describe calls of the fleet group. A run stopped half way leaves open merge requests; the next run closes them. No token is printed.
