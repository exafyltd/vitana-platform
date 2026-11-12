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
3. **The role of the GitLab machine is allowed to read the fleet group.** `terraform/settings.tf` (statement `ReadTheFleetGroupForTheRehearsal`)
   grants it `autoscaling:DescribeAutoScalingGroups` and `autoscaling:DescribeScalingActivities`, which A1 needs; apply that Terraform change first. The
   rehearsal does not wait to find out: before it writes anything it reads the fleet group and its scaling activities once, and **refuses to start**
   (exit 2, nothing written) when either read is denied, naming both actions and the one that was denied. `--dry-run` makes the same two reads, so
   `node scripts/eng/rehearse.mjs --project rehearsal --dry-run` on the GitLab machine answers the question without starting anything. A read that
   fails for another reason (a throttled call) does not refuse; it is noted in the report.
4. **The seed passes its own tests on this machine.** The tooling the seed carries in `tools/collab/` is copied from this machine's checkout of `main`, and the
   seed's tests import it. Before the first write the rehearsal runs the seed's tests (the `node --test` part of its `npm test`) in a temporary directory and
   refuses to start when they fail, instead of finding out after the 25 minutes the seed merge request would otherwise wait. The negative controls are not
   run there: they would probe this machine, not a job.

## What it does

| Step | What |
|---|---|
| Checks | The project must be marked `rehearsal: true`, `native`, `landing: true` and without a webhook in `gitlab-settings.json`, and the live project must agree: no webhook, no mirror, `main` push **No one**, merge Maintainers, no force push. Every token must belong to the account it is stored for. No open merge request may be from anywhere but an earlier rehearsal. `CLAUDE.md` must be a protected gate file under the rules of this machine. The role of the machine must be allowed to read the fleet group (one read of each of the two operations), and the built seed must pass its own tests in a temporary directory. |
| Hygiene | Merge requests left open by an earlier run (branch `rehearsal/…`) are closed. |
| Seed | If `main` does not hold `seed/` (this folder) it is put there by a merge request of lane `rehearsal/seed`: built by a seat, accepted by `agent-reviewer`, landed by the bot like any other. `main` takes no push. A current seed is left alone; an outdated file is updated through the same route; the lane files, which runs grow, are created once and never rewritten. |
| Wave 1 | Five control merge requests (they are the oldest, so the bot reads them first), then 12 lane merge requests, round robin over `agent-kiro-exafy`, `-exafyltd`, `-jtadic`, `-hotmail`. One commit each, new files only, named by run and lane, so no two merge requests touch the same path. |
| Wave 2 | As soon as the first job of a first-wave merge request has started (or after 8 minutes; a job on a pipeline of `main` does not count): `agent-reviewer` commits the accept on every lane and on three controls, so up to 24 pipelines are in flight at once. The jobs of the first wave last seconds and their machines are deleted when they end, so waiting for the last of them would let those machines be gone before the second wave asks for its own; the others are still waiting for a machine or booting when it arrives, which is a machine in the group all the same. The controls get their faults. |
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
the three negative controls of A2, one line each (`NEGCTL <name> PASS|FAIL`, preceded by a `negctl: <name>: <detail>` line that says what was seen),
which the rehearsal reads from the job trace:

| Line | PASS means |
|---|---|
| `NEGCTL imds PASS` | no metadata token is issued to a job container and a plain read returns no data. The job asks the metadata service (169.254.169.254) for a token (`PUT /latest/api/token`) and reads `/latest/meta-data/` without one. It fails only when the token request answers 2xx (a token was issued) or the read answers 2xx. A timeout, a connection error, 401 and 403 are a pass: with tokens required and hop limit 1 the answer to the token request never reaches the container and AWS answers a read without a token with 401, which is the protection working. The statuses seen are in the detail; a token in an answer is never read or printed |
| `NEGCTL gitlab-host PASS` | the private address of the GitLab machine accepts no connection on 22, 80, 443 or 8080 from a job |
| `NEGCTL aws-env PASS` | no environment variable of the job starts with `AWS_` |

A control that fails prints `FAIL` and does not fail the job: the rest of the rehearsal still runs and the report decides. The report shows the first
detail line of a control that failed.

After the three controls the job prints one more line that is **not a control**: `NEGCTL-INFO baseline gitlab: reachable|not reachable|not checked (...)`.
It says whether the job can open a connection to GitLab (the host and port of `CI_SERVER_URL`) at all, because a container with no network passes the
two network controls without any isolation having been shown. It never changes a control line or the exit code. The report counts it as an information
line under A2 and says where GitLab was not reached.

## Reading the report

`RESULT: PASS` needs all of A1, A2, A3, A4 and A8 to be PASS and the run to have finished. A verdict is `FAIL` when a check found the opposite of the claim and
`NOT PROVEN` when it could not be made (unreadable ASG, unreadable traces, a token that GitLab did not answer for). Under `PROBLEMS AND NOTES` the
report names jobs that never finished, the machine launches that AWS refused (with its message), and every lane that did not land with each reason the
bot gave.

| Symptom | Usually |
|---|---|
| `STOPPED in seed … did not land within 25 minutes` | the bot timer is off or failing (`journalctl -u vitana-land`), or the first pipeline never got a machine |
| `STOPPED in seed … no push event of agent-reviewer` | this GitLab does not record API commits as pushes. The bot trusts only a review commit found in a push event of `agent-reviewer`, and this script makes its commits through the API only, so it stops with that reason instead of waiting |
| `refusing to start … may not read the fleet group` | the role of the GitLab machine lacks `autoscaling:DescribeAutoScalingGroups` or `autoscaling:DescribeScalingActivities`; `terraform/settings.tf` grants both: apply it |
| `A1 … NOT PROVEN … the ASG could not be read` | the reads worked before the run but failed during it (a service error, a throttled call): the error is in the line. A failed read is tried again at the next poll |
| `A1 … peak fleet size < 20` | machines are slow to start, jobs are cancelled by newer pushes, or the fleet maximum is below 20 |
| `A2 … FAIL` for `imds` | a token was issued to a job or a read without a token returned data (the line says which, with the statuses): the launch template allows a hop limit above 1 or IMDSv1, or the job runs with host networking |
| `[skip] baseline … NOT reached in N` | in N jobs the container could not reach GitLab at all, so the two network controls prove nothing there: look at the job trace |
| `review_forged` on a lane, in `comments on the lane merge requests` | usually the push event lag, when that lane did land: GitLab records the push of a review a moment after the push, a tick of the bot that reads first refuses once, and the next tick lands the lane. Only a lane that did not land is a problem; `PROBLEMS AND NOTES` lists those with every reason the bot gave. In the controls, `review_forged` is the expected answer to the accept of the builder |
| `A2 … FAIL` for `gitlab-host` | the security group of the GitLab machine admits the job group |
| `A3 … settings check exit 3` | a setting was changed by hand; `m2.sh settings` puts it back |
| `A4 … no refusal with reason …` | the bot refused for another reason, or not at all: read what it said under `BOT REFUSALS` |

## What it writes, and where

Only the project `vitana/rehearsal`, with four calls: `POST …/repository/commits`, `POST …/merge_requests`, `PUT …/merge_requests/:iid` (close only) and
`DELETE …/repository/branches/:name`. It never writes `main` (nobody can, and the script itself refuses any commit to `main` or delete of it before a
request leaves), never touches another project, a runner, a user, a setting or a secret, and never calls production, the gateway or Supabase. AWS is read
only: the seven token secrets `vitana/engineering/gitlab/agents/<username>` and the two Describe calls of the fleet group (once before the run, at every
poll, and the scaling activities once at the end, at most 500 of them). A run stopped half way leaves open merge requests; the next run closes them.
No token is printed; an error nothing caught is printed as one line with every secret the run has read removed.
