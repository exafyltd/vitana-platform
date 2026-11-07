---
change_class: standard
---
# plan(eng-gitlab-m2): GitLab ready for many agents, on the Free tier

Author: Kiro, seat `exafy`, session `kiro-exafy-202611021438-cff7` (Kiro Web). Premises pinned to vitana-platform
`origin/main` `3dc28e5fa74f314b2193ef11a141a8bcc0d8d85c` and vitana-v1 `origin/main`
`02c75006d36b54af0fa4be52d4b3501ef6251d5d` (the vitana-platform premise is the base commit of this PR; vitana-v1 is only read). Builds on plan `eng-gitlab-m1`
(GitLab, one runner, mirror; PR #4666, not merged when this was written). A lane here that extends a file of M1 starts
when the M1 lane that owns that file is `done` (§4).

<!-- plan:begin -->
## 1. Goal
Owner, 2026-11-03: *"we want to have selfhosted GitLab CI in place to speed up our system development and autonomous
self healing and self improvement system"*, and: *"we only pay for aws instances. no license fees to GitLab or others.
self hosted we only pay for aws"*.

Milestone 2 makes the GitLab of milestone 1 ready for dozens of agents working at the same time, with no licence. It is
done when all of these hold (proof in §9):
- CI jobs of agent branches run on a fleet of throw-away machines that grows from zero with the queue and returns to
  zero. One job per machine. The machines hold no AWS permission and no secret.
- Every agent seat has its own GitLab login (a service account). Nobody except the merge bot and the owner can change
  `main` of a project that agents work in.
- A merge bot lands a merge request only when the decision functions of `scripts/collab/land-guard.mjs` say so (review
  current for the head, checks green, branch up to date, no protected gate file).
- Merge-request and pipeline events reach the gateway as OASIS events (the route is ready; it is switched on at cutover).
- Alarms tell the owner when CI is down, stuck, not backed up or over budget.
- A rehearsal with 12 parallel agent merge requests in a scratch project passes end to end.

Not in milestone 2: moving a real repository to GitLab (decision D1, stage 2), the gateway's provider abstraction for
`api.github.com`, deploy jobs or any AWS credential in GitLab, container-image builds in CI, per-merge-request preview
environments, a batch merge queue, high availability. They are milestone 3 and later (§10).

## 2. The Free-tier rule (owner decision 2026-11-03; it replaces decision D2 of `docs/ENGINEERING-PLATFORM-PLAN.md`)
GitLab runs as the Enterprise package without a licence key, which is the Free tier. No licence, subscription or seat is
bought, now or later. The only cost is AWS. Checked against GitLab's own documentation on 2026-11-03: service accounts
(Free; 100 per self-managed instance; no seat), merge request approvals (Free: optional, Developer and up), merge
methods and squash (Free), project webhooks with a signing token (Free; group webhooks are Premium). The runner and its
AWS autoscaling plugin are open-source projects; the documentation lane records their licences.

| What the first plan counted on (Premium) | What milestone 2 does on Free |
|---|---|
| Merge trains, merged-results pipelines | Merge method fast-forward with squash: GitLab itself refuses a merge request that is behind `main`. The bot brings the branch up to date by merging `main` into it (not a rebase, so the reviewed head stays an ancestor), waits for the new pipeline, then lands it. One landing per project at a time. This is rule §7b of `collaboration.md` as it runs today, at the same rate. A batch queue is a later lane if the rate is not enough. |
| Required approvals, Code Owners | The reviewer's accept stays in git trailers as today. The bot checks it with the `land-guard.mjs` functions and, new, checks that the accept commit was pushed by the `agent-reviewer` account (project push events). A builder cannot forge that. |
| Owner approval of protected gate files | The bot never lands a change to a file in `protected-gate-files.json` (as `land-guard.mjs merge` already refuses). It comments that the owner must. The owner merges it in GitLab. |
| Push rules | Central CI configuration in `vitana/ci-config`, which agents cannot edit, plus a list of required job names per project that the bot checks. |
| Protected environments, deployment approvals | Not needed: milestone 2 has no deploy job. Production stays the Command Hub PUBLISH button and Gate 2. |
| Branch protection by user or group | By role: push `No one`, merge `Maintainers`. Only `bot-land` and the owner hold Maintainer. |
| Group webhooks | One project webhook per project, created by the settings sync. |
| Unlimited service accounts | 100 per instance. One account per seat, not per session. A session is still identified by its `Collab-Session` trailer. About ten accounts are used. |

Everything else in the stack is free software or an AWS service we already pay for. The documentation lane lists every
component with the licence named in its own repository; a component with a fee fails the lane.

## 3. Interfaces (fixed here; every lane builds to these)
### 3.1 Trusted and untrusted machines
- **Trusted:** the GitLab host. It holds the bot tokens and runs the services of §3.3 to §3.6 as systemd units. It runs
  no CI job.
- **Untrusted:** the fleet. It runs every job of every branch and merge request. It has no secret, no protected CI/CD
  variable and no AWS permission.
- M1's persistent runner `vitana-eng-1` is retagged `vitana-legacy` by the first settings sync, before any agent token
  exists, so no pipeline selects it. It is paused after acceptance A1. Removing the machine from Terraform is milestone 3.

### 3.2 Fleet (lane `fleet`)
New Terraform files next to M1's `main.tf` (M1 files are not edited), same account, region, VPC and private subnets.
- ASG `vitana-eng-fleet`: min 0, desired 0 (Terraform ignores later changes to `desired_capacity`; the runner sets it),
  max `fleet_max_instances` (default 24), scaling policy none, `AZRebalance` suspended, `protect_from_scale_in`,
  `capacity_rebalance` off. Mixed instances `m6i.xlarge`, `m6a.xlarge`, `m5.xlarge`, `m5a.xlarge`; spot share
  `fleet_spot_percent` (default 80).
- Launch template: AMI built by EC2 Image Builder (Ubuntu 24.04, Docker Engine, EC2 Instance Connect, user `ubuntu` in
  group `docker`, the Node 20 job image and the runner helper image for `runner_version` pre-pulled, no runner binary),
  100 GB encrypted gp3 with the M1 KMS key, no public IP, IMDSv2 required with hop limit 1, an instance profile with no
  policy.
- Security group `vitana-eng-fleet-job`: ingress tcp 22 from `vitana-eng-fleet-manager` only; egress tcp 80, tcp 443 and
  DNS. Nothing else.
- Manager `vitana-eng-fleet-manager`: EC2 `t3.medium`, private subnet, SSM, IMDSv2 hop limit 1, no Docker. Its role holds
  only: `SetDesiredCapacity`, `SetInstanceProtection` and `TerminateInstanceInAutoScalingGroup` on this ASG;
  `DescribeAutoScalingGroups`, `DescribeInstances`, `DescribeSpotInstanceRequests`;
  `ec2-instance-connect:SendSSHPublicKey` on instances of this ASG; read of the secret
  `vitana/engineering/gitlab/fleet-runner-token`; the cache bucket; the M1 KMS key. No stored SSH key: the plugin sends a
  one-time key through EC2 Instance Connect.
- `config.toml` (rendered by `host/fleet-manager-install.sh`): executor `docker-autoscaler`, plugin `aws` (installed with
  `gitlab-runner fleeting install`), `capacity_per_instance = 1`, `max_use_count = 1`, `max_instances` = `concurrent` =
  `fleet_max_instances`, `idle_count = fleet_idle_count` (default 0), `idle_time = "10m0s"`, connector user `ubuntu` with
  `use_external_addr = false`, `privileged = false`, no Docker socket mount, `pull_policy = ["if-not-present"]`, cache in
  S3 bucket `vitana-engineering-ci-cache-<account id>` (SSE-KMS, 7-day expiry) through the regional S3 endpoint.
- Runner `vitana-eng-fleet`: tag `vitana-eng` (the tag the central CI already uses), not protected, no untagged jobs.
  The settings sync creates it and stores its token in `vitana/engineering/gitlab/fleet-runner-token`. Terraform creates
  the empty secret; the manager waits for a `glrt-` value, as M1's runner host does.
- Quota: a new account starts with low vCPU limits. The fleet needs `fleet_max_instances × 4` vCPUs in both the On-Demand
  and the Spot "Standard" quotas. A Terraform `precondition` reads both and, when too low, fails with the exact
  `aws service-quotas request-service-quota-increase` commands for the owner.

### 3.3 Settings as code (lane `settings`)
- `infra/gitlab-engineering/settings/gitlab-settings.json` (schema version 1) is the single source of truth:
  `gitlab_url`, `group`, `owners` (usernames; default `["root"]` until the owner names their account), `projects.<name>`
  with `profile` (`mirror` | `native`), `landing` (bool), `rehearsal` (bool), `required_jobs` (names), optional
  `webhook` (`url`, events), and `accounts` (username, role, projects). Projects at start: `vitana-platform` and
  `vitana-v1` (`mirror`, `landing:false`, no agent member) and `rehearsal` (`native`, `landing:true`, `rehearsal:true`,
  no webhook, no mirror).
- `scripts/eng/gitlab-settings.mjs` applies it and nothing else: instance service accounts (`agent-kiro-exafy`,
  `agent-kiro-exafyltd`, `agent-kiro-jtadic`, `agent-kiro-hotmail`: Developer; `agent-reviewer`: Developer; `bot-land`:
  Maintainer; `bot-metrics`: Reporter), their tokens (90 days, rotated when under 30 days left, stored in
  `vitana/engineering/gitlab/agents/<username>`; the tokens of `bot-land` and `bot-metrics` are also written to
  `/etc/vitana/bot-land-token` and `/etc/vitana/bot-metrics-token`, mode 0600), project membership, the protected-branch
  profile, the project merge
  settings, the fleet runner and the legacy-runner retag, the project webhooks (HMAC signing token in
  `vitana/engineering/gitlab/webhook-signing-token`), and the content of `vitana/ci-config` from
  `infra/gitlab-engineering/ci/*.yml`. Idempotent: a second run makes no write. `--check` writes nothing and exits 3 on drift.
- Profile `mirror`: M1's behaviour (the mirror user pushes, force push allowed). Profile `native`: `main` push `No one`,
  merge `Maintainers`, force push off; merge method fast-forward, squash always, pipelines must succeed, discussions
  resolved, source branch removed after merge, automatic rebase off, squash and merge message template `%{title}` (the
  VTID in the title reaches `main`, which STAGING-VERIFY needs: `quality-checks.md` "Merge").
- Central CI (`infra/gitlab-engineering/ci/`): merge-request pipelines for `native` projects, `retry` on
  `runner_system_failure` / `stuck_or_timeout_failure`, `interruptible`, tag `vitana-eng`, a file for `rehearsal`.
- Licence guard: the sync stops with a loud message when `GET /license` returns a licence, and a static test fails on any
  Premium-only API path or setting name in `infra/gitlab-engineering/**` and `scripts/eng/**`.
- It runs on the GitLab host from a systemd timer every 10 minutes, from the host's checkout `/opt/vitana/platform` of
  `main` of the mirrored `vitana/vitana-platform`; `ops-install.sh` (run once by the owner through `m2.sh install`)
  installs node, the checkout, and every unit in `host/units/*` and script in `host/ops.d/*`. One unit,
  `vitana-platform-sync`, fast-forwards the checkout every minute under a lock; the other units only read it.

### 3.4 Landing (lane `merge-bot`)
`scripts/eng/gitlab-land.mjs run` (timer every minute, `flock`, `Nice`, `CPUQuota`, `MemoryMax`) goes through the projects
with `landing:true` and, per project, looks at open merge requests to the default branch, oldest first, one landing per
tick:
- It imports the decision functions of `land-guard.mjs` unchanged (`laneKeyOf`, `localAfter`, `reviewCurrent`,
  `checksVerdict`, `protectedTouched`, `mergeDecision`) and `commitsInRange` and `PROTECTED_GATE_PATHS` from `queue.mjs`,
  on a local clone of the project whose `origin/main` is the target branch and whose merge request head is fetched from
  `refs/merge-requests/<iid>/head`. Neither file is edited, so the rules cannot drift between GitHub and GitLab.
- Review: the newest `Collab-Verdict: accept` commit on the merge request that names the lane
  (`Collab-Review`, `Collab-Reviewer: agent:vitana-lane-reviewer (…)`, `Collab-Reviewed-Head`); it must have been pushed by
  `agent-reviewer` (project events: `push_data.commit_from..commit_to` contains it); `reviewCurrent` decides whether it
  still counts for the head.
- Checks: the jobs of the pipeline for exactly the head SHA (`GET …/pipelines/:id/jobs`, which returns the latest attempt of
  each job and leaves out retried ones unless asked). `checksVerdict` reads GitHub check runs (`land-guard.mjs:85`: `name`,
  `id`, `started_at`, `status`, `conclusion`, with `OK_CONCLUSIONS` = success, skipped, neutral at `land-guard.mjs:32`), so
  one pure, exported function `jobToCheckRun(job)` in `gitlab-land.mjs` turns each GitLab job into that shape
  (`name` = job name, `id` = job id, `started_at` = the job's). The table is complete for the job statuses GitLab documents:

  | GitLab job `status` | `allow_failure` | check run `status` / `conclusion` | `checksVerdict` |
  |---|---|---|---|
  | `success` | any | completed / success | pass |
  | `failed` | false | completed / failure | fail |
  | `failed` | true | completed / neutral | pass |
  | `canceled` | any | completed / cancelled | fail |
  | `skipped` | any | completed / skipped | pass |
  | `manual` | true (optional job) | completed / neutral | pass |
  | `manual` | false (blocking job, waits for a person) | queued | pending |
  | `created`, `pending`, `scheduled`, `preparing`, `waiting_for_resource`, `waiting_for_callback` | any | queued | pending |
  | `running`, `canceling` | any | in_progress | pending |
  | any other value | any | queued, and one log line | pending (fails closed) |

  Every name in the project's `required_jobs` must be present and map to `success`: a required job that is absent,
  skipped, neutral or still running does not pass. A pipeline with no jobs yet is pending (`checksVerdict([])`).
- Behind `main`: it merges `origin/main` into the source branch (author `bot-land`, trailer `Collab-Session`), pushes,
  and waits for the next tick. While the oldest eligible merge request waits for its pipeline, no other merge request of
  that project is updated (at most 60 minutes, then it loses its turn); a merge request that needs a human (no review,
  red check) is skipped, not waited for.
- Ready: `PUT …/merge` with `sha` = head, `squash=true`, `squash_commit_message` = merge request title + description,
  remove source branch. A refused merge changes nothing and is retried at the next tick.
- Protected gate file in the diff: not landed; one comment per head and reason; the owner merges.
- Fails closed: any API or git error lands nothing. `--dry-run` writes nothing. A comment is written once per
  (head, reason). Logs are JSON lines without tokens. Token file `/etc/vitana/bot-land-token`.

### 3.5 Gateway route (lane `scm-webhook`)
- `POST /api/v1/internal/gitlab/webhook`, mounted with `express.raw` before `express.json()` (as
  `index.ts` does for the vendor webhooks), verifying GitLab's Standard Webhooks signature with the existing `verifySvix`
  of `connectors/runtime/webhook-signature.ts:59`. The signing key is `GITLAB_WEBHOOK_SIGNING_TOKEN` in `whsec_<base64>`
  form. `verifySvix` takes its inputs as `{ id, timestamp, signature }` and never reads a header name, so the route maps
  the headers itself, as the Vital connector does for `svix-*` (`connectors/wearable/vital.ts:186-191`):
  `id: headerValue(req.headers['webhook-id'])`, `timestamp: headerValue(req.headers['webhook-timestamp'])`,
  `signature: headerValue(req.headers['webhook-signature'])`. The shared verifier is not edited. Fails closed (no key: 500
  `not_configured`), 401 on a bad, missing or stale signature, JSON replies only. A request that carries only `svix-*`
  headers is refused.
- Maps `merge_request` and `pipeline` events to five new OASIS topics, all added to `CicdEventType`
  (`services/gateway/src/types/cicd.ts:139`, the closed union that `CicdOasisEvent.type` requires, `cicd.ts:1220`):

  | GitLab event | `object_attributes` value | OASIS topic |
  |---|---|---|
  | `merge_request` | `action` = `open` or `reopen` | `scm.gitlab.merge_request.opened` |
  | `merge_request` | `action` = `merge` | `scm.gitlab.merge_request.merged` |
  | `merge_request` | `action` = `close` | `scm.gitlab.merge_request.closed` |
  | `pipeline` | `status` = `success` | `scm.gitlab.pipeline.succeeded` |
  | `pipeline` | `status` = `failed` | `scm.gitlab.pipeline.failed` |

  No existing topic is reused. Of the three names the first draft listed, only `cicd.merge.success` is in the union
  (`cicd.pr.created` and `cicd.ci.failed` are strings that `autopilot-event-mapper.ts:269,454` reads but typed code cannot
  emit), and `cicd.merge.success` is the Command Hub's own "merged" signal: `board-adapter.ts:353` turns it into a
  COMPLETED board card and `gemini-operator.ts:3210` reads it as "PR merged". A GitLab event must not complete a real VTID.
  The lifecycle mapper `autopilot-event-mapper.ts` is not edited and has no rule for `scm.gitlab.*`, so in this milestone
  no GitLab event moves a VTID's state (a test asserts it); that mapping belongs to the vitana-v1 cutover (§10). The VTID is
  the first `VTID-\d{5}` in the merge request title (`merge_request` events), or in `merge_request.title` and then
  `commit.title` (`pipeline` events); with none, the event is acknowledged and ignored (202). Every other event or action
  is acknowledged and ignored (202). Retries are dropped by `webhook-id`.
- Staging gets the key from the Secrets Manager secret `vitana/gateway/staging/gitlab-webhook-signing-token` when it
  exists (absent: not wired, the deploy never fails), in `AWS-STAGE-DEPLOY-GATEWAY.yml`. Production is not wired in this
  milestone: no real project has a hook yet, and `AWS-PROD-*` workflows are protected gate files.
  `scripts/aws/setup-gitlab-webhook-secret.sh` (dry run by default) copies the value from the engineering account.

### 3.6 Monitoring (lane `monitoring`)
CloudWatch namespace `Vitana/Engineering`, SNS topic `vitana-eng-alerts` (KMS), alarms: oldest pending job over 10 min;
fleet at maximum for 30 min; GitLab host status check, disk over 80 %, load balancer unhealthy target; no backup newer
than 30 h; no completed tick of the merge bot or the settings sync for 15 min; a monthly AWS Budget (50, 80, 100 %).
`scripts/eng/ci-metrics.mjs` (timer every minute, user `bot-metrics`, read only) publishes the job-queue metrics.

### 3.7 Test helpers (lane `gitlab-client`)
`scripts/eng/gitlab-api.mjs`: `createClient({ baseUrl, token, fetch, sleep })` with `request`, `paginate`, retry with
back-off on 429 and 5xx, no retry on other 4xx, an error type that carries status, method and path and never a token.
`scripts/eng/testing/fake-fetch.mjs`: a recording fake `fetch` so tests assert the exact calls (for example "the second
apply made no write"). Dependency-free Node, because `UNIT.yml` runs `scripts/**/*.test.mjs` with no install.

### 3.8 Rehearsal (lane `rehearsal`)
`scripts/eng/rehearse.mjs --project rehearsal --agents 12` creates the project content from `infra/gitlab-engineering/rehearsal/seed/`
(a tiny repository with the collab tooling copied from `main`, a spec with 12 lanes), opens 12 merge requests from the four
seat accounts, plays the reviewer as `agent-reviewer`, waits for the bot, and prints a report: peak fleet size sampled
from the ASG, whether each job ran on its own instance, time to scale to zero, the commit subjects on `main`, the
refusals the bot gave, and the negative-control job results. It refuses to run unless the project is marked
`rehearsal:true`, `native`, with no webhook and no mirror. The owner starts it with `m2.sh rehearse`.

## 4. Lanes
Seven lanes, vitana-platform only, executor kiro, seat `exafy`. `depends_on` lists real file or API dependencies.
- `gitlab-client` (no dependency): §3.7.
- `fleet` (none): §3.2.
- `settings` (`gitlab-client`): §3.3 and the documentation amendment (D2 and the lines of
  `docs/ENGINEERING-PLATFORM-PLAN.md` that assume Premium: F5, D2, the owner-actions list, the CODEOWNERS row, "turn merge
  trains on", the 20-parallel-pipelines line and the seat-cost risk), the component licence list, and the guard test.
- `merge-bot` (`gitlab-client`): §3.4.
- `scm-webhook` (none): §3.5. The only lane that deploys (staging gateway).
- `monitoring` (`gitlab-client`): §3.6.
- `rehearsal` (`gitlab-client`, `fleet`, `settings`, `merge-bot`): §3.8.
The lanes that add Terraform (`fleet`, `settings`, `monitoring`) start when M1 lane `gitlab-infra` is `done`, because
`terraform validate` needs M1's `main.tf` in the tree. Lane files cannot name a lane of another plan in `depends_on`, so
the plan driver applies this rule from here. `gitlab-client`, `merge-bot` and `scm-webhook` can start at once.
Terraform: each lane adds its own `.tf` file with its own variables and outputs; none edits another lane's file. Host
files: `host/units/*` and `host/ops.d/*` are picked up by `ops-install.sh` by glob, so a lane adds a file and edits no
shared script. Cross-lane names (secrets, ASG, security groups, namespace, paths) are those of §3 exactly.

## 5. Tests (each red on base; Node tests run in `UNIT.yml`, the gateway tests in the gateway Jest suite)
- `gitlab-client`: `scripts/eng/gitlab-api.test.mjs` (pagination over three pages; retry on 429 then success; no retry on
  404; the error text never contains the token), `scripts/eng/testing/fake-fetch.test.mjs`.
- `fleet`: `scripts/eng/fleet-structure.test.mjs` reads the Terraform and the rendered `config.toml`: min 0 / desired 0 and
  `ignore_changes` on `desired_capacity`, scale-in protection, `AZRebalance` suspended, IMDSv2 hop limit 1, no public IP,
  the job instance profile has no policy, the job group accepts tcp 22 only from the manager group, the manager policy lists
  exactly the actions of §3.2 on the ASG ARN, `capacity_per_instance = 1`, `max_use_count = 1`, `privileged = false`, no
  `docker.sock`, the quota `precondition` exists; no `0.0.0.0/0` ingress.
- `settings`: `scripts/eng/gitlab-settings.test.mjs` (second run makes zero writes; `--check` exit 3 on a changed branch
  protection; tokens are created once, rotated under 30 days, never printed; licence present: refuses; legacy runner
  retagged before any account token is created; `mirror` and `native` profiles), `scripts/eng/free-tier-guard.test.mjs`
  (fails on `approval_rules`, `push_rule`, `merge_trains`, `protected_environments`, `code_owner_approval_required`,
  group hooks and similar Premium names; passes on the repo today).
- `merge-bot`: `scripts/eng/gitlab-land.test.mjs` on real temporary git repositories and the fake `fetch`: lands a reviewed,
  green, up-to-date merge request with the pinned `sha` and squash message; refuses with no review, with an accept pushed by
  a builder, with an old head that changed code, with a red or missing required job; skips on pending; updates a behind
  branch by merge and does not land it in the same tick; does not touch a second merge request after a landing; refuses a
  protected gate file and comments once; `--dry-run` writes nothing; a table of inputs gives the same verdicts as
  `mergeDecision` itself; `jobToCheckRun` is tested row by row against the §3.4 table (every documented status, both
  values of `allow_failure` where the table distinguishes them, and an unknown status), each result then run through the
  real `checksVerdict`; a required job that is skipped, neutral or absent does not pass.
- `scm-webhook`: `services/gateway/test/routes/internal-gitlab-webhook.test.ts` (valid signature with the `webhook-*`
  headers 200; bad 401; stale timestamp 401; `svix-*` headers only 401; no key 500 with JSON; duplicate `webhook-id` emits
  once; each of the five mapped events emits its topic from the §3.5 table; an event with no VTID, an unknown event and an
  unmapped action answer 202 and emit nothing; the raw parser sits before the JSON parser in `index.ts`), a compile-time
  check that the five topics are members of `CicdEventType` (the route file typechecks with them), a test that no rule of
  `autopilot-event-mapper.ts` lists a topic starting `scm.gitlab.`, and `docs/validation/<VTID>/staging-tests.json`.
- `monitoring`: `scripts/eng/monitoring-structure.test.mjs`, `scripts/eng/ci-metrics.test.mjs` (a failed API read publishes a
  failure metric and no zeros).
- `rehearsal`: `scripts/eng/rehearse.test.mjs` (plan of 12 merge requests; refuses an unmarked or mirrored project; report
  maths).
- Real checks: `terraform fmt -check` and `terraform validate` output in the lane evidence; the owner's apply; rehearsal A1–A8.

## 6. Rollout (owner steps are marked ▶; each is one command)
0. Precondition: M1 is up, the mirror runs, the first pipelines are green.
1. Lanes merge under the pipeline's rules (§7b). Nothing deploys except the `scm-webhook` change to staging.
2. ▶ Quotas: if the Terraform plan stops on the quota check, run the printed `aws service-quotas …` lines and wait for AWS.
3. ▶ Kiro sends one new paste block; `bash ~/vitana-eng/setup.sh` runs again (about 30 minutes, mostly the image build).
4. ▶ `bash ~/vitana-eng/m2.sh install` (once): node, the checkout, the timers on the GitLab host.
5. The settings sync runs by itself: retags the legacy runner, creates accounts, protections, the fleet runner, the
   rehearsal project. The manager starts the fleet runner when its token appears.
6. ▶ `bash ~/vitana-eng/m2.sh rehearse`; the report is acceptance A1–A8. Kiro reads it from the pasted output.
7. ▶ After the `scm-webhook` change passed STAGING-VERIFY: `scripts/aws/setup-gitlab-webhook-secret.sh --apply` in CloudShell.
8. ▶ Tokens for the seats are handed out only when the owner decides the cutover (milestone 3).

## 7. Cost
Always on, added: the manager (`t3.medium`), a few Secrets Manager secrets, CloudWatch alarms and metrics, the cache bucket.
Variable: job machines, billed only while jobs run: roughly (jobs per day) × (minutes per job + about one minute of boot)
× the hourly price of a 4-vCPU machine, spot for 80 %. Levers, in this order: spot share, `fleet_max_instances`,
`capacity_per_instance` above 1 (less isolation), `fleet_idle_count` above 0 (faster start). NAT data transfer is the
other driver; the S3 endpoint already keeps cache traffic off the NAT gateway. The `fleet` lane writes the monthly
estimate from the AWS price list into its evidence. The monitoring lane's budget alarm is the backstop.

## 8. Risks
- The fleet, the image build and the plugin have never run in this account. The rehearsal exists to find that out before any
  real repository moves.
- One GitLab host runs GitLab and the timers. If it is down nothing lands, which is also true without the timers.
- The trusted host runs code from `main` of the mirrored `vitana-platform`. Whoever can change that `main` on GitHub can
  change what runs there; that is the same set of people and gates that can change the production deploy workflows today.
  The checkout only fast-forwards, and the host's role can write only the secrets of M1 and M2, the backup bucket and
  CloudWatch metrics.
- Free has no merge train: landings are one at a time per project, so throughput is about one landing per pipeline length.
  The fast-forward plus squash combination (a branch that contains a merge of `main` must still fast-forward and squash to
  one commit with the VTID in its subject) is confirmed by A4. If it is not, fall back to the merge-commit method with the
  `%{title}` template on both commit kinds, which also satisfies STAGING-VERIFY.
- A human Maintainer can bypass the bot. Only the bot and the owner are Maintainers; the settings sync reports any other.
- A lost `200` can make GitLab resend an event; dedupe by `webhook-id` is per gateway task, so a duplicate is possible
  across tasks. No GitLab topic drives the VTID lifecycle in this milestone (§3.5), so a duplicate adds one informational
  OASIS row and moves no state.
- Spot interruptions fail a job; the central CI retries it once.
- No Docker-in-Docker and no image builds in CI yet (no privileged containers, no socket mount). Jobs that build images wait
  for a rootless builder in milestone 3.
- Service accounts are capped at 100; about ten are used.

## 9. Staging verification and acceptance
Only `scm-webhook` deploys. Its STAGING-VERIFY probe is read-only: an unsigned `POST` to the route must answer JSON 401 (key
set) or 500 `not_configured` (key absent), never 404 or HTML. All other lanes deploy nothing and say *not verified on
staging: separate AWS account, no product path*, with the structure tests and the owner's apply as proof. A live GitLab
event is not sent to staging: it would write OASIS rows, so the mapper is covered by Jest and goes live at cutover.

| # | Acceptance | Proof |
|---|---|---|
| A1 | 12 parallel merge requests: the fleet reaches at least 20 job machines, every job got a machine of its own (instances launched is at least the jobs run, from the ASG activity history), and the group is back at 0 within 15 minutes of the last job | rehearsal report |
| A2 | Negative-control jobs prove: the instance metadata service is unreachable from a job container, the GitLab host's private address is unreachable, no `AWS_*` variable exists in the job | rehearsal report |
| A3 | `main` of `rehearsal`: nobody can push; the only Maintainers are `bot-land` and the owner; tokens expire in at most 90 days; `gitlab-settings.mjs --check` exits 0 | rehearsal report, sync log |
| A4 | The bot lands 12 merge requests one at a time; each is exactly one commit on `main` with the VTID in the subject; a merge request with no current review, a builder-pushed accept, a red required job, or a protected gate file is refused with the reason | rehearsal report |
| A5 | The webhook route: signature, stale, duplicate and mapping cases pass in Jest; the staging probe passes | gateway tests, STAGING-VERIFY |
| A6 | Each alarm exists; a test message reaches the owner's address | `m2.sh status`, owner confirms |
| A7 | No licence: `GET /license` is empty, the guard test is green, the component list shows no fee | sync log, test, doc |
| A8 | The legacy runner is retagged before the first agent token and paused after A1 | sync log |
| A9 | The cost estimate and the first week's AWS cost are written next to each other | fleet evidence, owner |

## 10. Unchanged and later
GitHub Actions, every deploy workflow, production, the gateway except the one new route and the five new topic names,
`autopilot-event-mapper.ts` and the Command Hub's reading of `cicd.*` topics, production DNS, M1's files,
`eng-platform-p02` (paused). Later: the vitana-v1 cutover (mirror direction flips for that project, hook turned on,
production wiring of the secret, and the lifecycle rules that let `scm.gitlab.*` topics move a VTID's state, which are
deferred here on purpose), the gateway's provider abstraction for the Project Manager, deploy jobs with GitLab OIDC
into AWS on a trusted runner, rootless image builds, per-merge-request previews, a batch merge queue, retiring the legacy
runner, RDS and a second GitLab node.
<!-- plan:end -->
