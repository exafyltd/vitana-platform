---
change_class: standard
---
# plan(eng-gitlab-m1): self-hosted GitLab CI, milestone 1 (put what is running under review, test it, close the open checks)

Author: Kiro, seat `exafy`, session `kiro-exafy-202611021438-cff7` (Kiro Web). Premises: vitana-platform `origin/main` at the base commit of this PR. The system described here was built on 2026-11-04 and has been running since; the files that built it are in the author's session and are not in git yet.

<!-- plan:begin -->
## 1. Goal
Owner, 2026-11-03: *"we want to have selfhosted GitLab CI in place to speed up our system development and autonomous
self healing and self improvement system."* The owner asked for it at once, so milestone 1 was built first, from a script
bundle that the owner ran in AWS CloudShell, and is documented here second. It runs today:
- GitLab EE 19.5.3 without a licence (Free tier) at `https://gitlab.vitanaland.com`, in the new AWS account
  `vitana-engineering` (841276716213), region `eu-central-1`, behind an HTTPS load balancer with an ACM certificate. DNS is
  in Cloudflare.
- One CI runner (Docker executor, tag `vitana-eng`) on its own machine.
- A mirror that copies `vitana-platform` and `vitana-v1` from GitHub into GitLab every 5 minutes. GitHub stays the source
  of truth.
- Pipelines on the mirrored `main` run a subset of GitHub's gateway and frontend checks (§3 and premises P6 and P9 in §2a),
  from a central configuration that branches cannot change.
- A nightly backup to an encrypted S3 bucket.

This plan does four things: it puts the bundle into git under `infra/gitlab-engineering/` so it is reviewed and
reproducible; it adds the structure test the bundle never had; it records the deviations from
`docs/ENGINEERING-PLATFORM-PLAN.md`; and it closes the two checks that are still unproven, the first green pipelines and
one restore from backup.

Not in milestone 1: agents pushing to GitLab, merge control, deploy jobs, autoscaling runners, GitHub as a mirror of GitLab,
self-healing. Milestone 2 (`eng-gitlab-m2`) covers what agents need.

## 2. Deviations from `docs/ENGINEERING-PLATFORM-PLAN.md`
- GitLab's built-in PostgreSQL and Redis on the GitLab machine, not RDS and ElastiCache (decision D4). Moving to RDS is a later task.
- One persistent runner machine, not the autoscaling fleet. Concurrency 3 on a 16 GB machine, 1 on a smaller one.
- GitLab Free. Decision D2 (Premium) is replaced in milestone 2 by the Free-tier rule.
- Pipeline configuration is central: the projects `vitana/vitana-platform` and `vitana/vitana-v1` use files in the project
  `vitana/ci-config` (`platform.gitlab-ci.yml@vitana/ci-config:main`), so a pushed branch cannot change the pipeline that
  checks it. There is no `.gitlab-ci.yml` in the repositories. Pipelines run for `main` and for manual, API and schedule
  runs only.
- The mirror is a systemd timer on the GitLab machine (`vitana-mirror`, every 5 minutes, one lock), not a GitLab project
  with a scheduled pipeline. It uses a GitHub fine-grained read-only token kept in Secrets Manager.
- Machine sizes are Terraform variables. The default is `m6i.xlarge` for both machines. A brand-new AWS account can start
  with a low EC2 vCPU limit, so `setup.sh` falls back to `m6i.large` and grows the machines later with `setup.sh grow`.
- The bundle is run by the owner from AWS CloudShell (`setup.sh`), because only the owner has AWS rights (decision D5).
  Resource names that must be unique carry the account id (state and backup buckets).
- Recovery point 24 hours (nightly backup), where D4 states 1 hour (`docs/ENGINEERING-PLATFORM-PLAN.md:34`). Recovery time:
  a rebuild from Terraform plus a restore, hours not minutes.
- Other items of the document's Phase 2 and Phase 3 that milestone 1 does not build (`docs/ENGINEERING-PLATFORM-PLAN.md:111-122`):
  - No S3 object storage: uploads, artifacts and LFS stay on the 200 GB volume (part of the D4 deviation).
  - No AWS Backup: the nightly `gitlab-backup` copy in S3 is the only backup.
  - CloudTrail, Config and Security Hub are not enabled in the new account (line 112). Tracked in §10.
  - Group layout: one group `vitana` with `ci-config`, `vitana-platform` and `vitana-v1`, named like the GitHub repositories so
    the mirror and the later cutover map one to one. The names `vitana/platform`, `vitana/v1`, `vitana/ci-templates` and
    `vitana/infra` of line 114 are not created.
  - Line 114 says nobody pushes to `main` directly. In milestone 1 the mirror user writes `main` of the mirrored projects with
    a forced update of every branch, and the instance default branch protection lets Maintainers push and force-push so that
    it can. The `mirror` profile of milestone 2 keeps this until the cutover; the `native` profile of milestone 2 forbids it.
  - Phase 3 (lines 119 and 121): no runner manager or autoscaling groups, concurrency 3 or 1 where the document says 10.
  - The pipelines of the two mirrored projects do not reproduce every GitHub check (§3).

## 2a. Premises the review can check (each readable on the base ref of this PR, `4066f563e7`)
Statements about the running system (account id, host names, versions, "answers 200", "runner verified") come from the
owner's CloudShell output and from outside checks on 2026-11-04. They are not in git until the lane merges, so they are not
premises of this review; the lane's structure test pins each value of §3 once the files are committed (§5). The premises that
are in git:

| # | Premise | Where |
|---|---|---|
| P1 | The programme document takes D2 (Premium), D4 (RDS, ElastiCache, RPO 1 h) and D5 (Kiro writes, the owner applies). This plan follows D5 and deviates from D2 and D4 as §2 says | `docs/ENGINEERING-PLATFORM-PLAN.md:32`, `:34`, `:35` |
| P2 | The document's Phase 2 and Phase 3 list the items §2 names as not built | `docs/ENGINEERING-PLATFORM-PLAN.md:111-116`, `:119-122` |
| P3 | The labels A01 to A05 are referred to but not defined in git; §9 states each in its own words | `docs/ENGINEERING-PLATFORM-PLAN.md:116`, `:122`, `:180` |
| P4 | `infra/` holds only `cognito-migration` and `livekit`; `infra/gitlab-engineering/` and `scripts/eng/` do not exist; the repository has no `.gitlab-ci.yml` | directory listing of `infra/` and `scripts/`; no tracked path matches `gitlab-ci` |
| P5 | `UNIT.yml` runs every `*.test.cjs` and `*.test.mjs` under `scripts/` with `node --test` and no install, so the structure test runs there without a workflow change | `.github/workflows/UNIT.yml:23`, `:25` |
| P6 | The platform pipeline takes its checks from two GitHub workflows: the gateway type check (`pnpm run typecheck` in `services/gateway`, script `tsc --noEmit`) and the four Jest shards of the gateway job (`pnpm install --frozen-lockfile`, `npx jest --shard=N/4`, Node 20.x). TEST-SUITE itself has no type check. The shard-union check is not ported | `.github/workflows/CICDL-GATEWAY-CI.yml:108`, `services/gateway/package.json:21`, `.github/workflows/TEST-SUITE.yml:43`, `:75`, `:88` |
| P7 | The lane's paths (`infra/gitlab-engineering/**`, `scripts/eng/gitlab-m1-structure.test.mjs`, `docs/validation/**`) match none of the governance paths, so the lane is an ordinary lane | `scripts/collab/queue.mjs:86-87` |
| P8 | The programme registers this plan | `docs/programs/engineering-platform/program.md:9`, `:23` |
| P9 | In vitana-v1 (companion ref `7829ef2f2e`, declared in `handoff.md`) the vitest job runs `npm run test:unit` (`vitest run`); the Deno test of the edge data client has no counterpart on GitLab; the PR-GATE type check, ESLint and design ratchets and the regression run are not ported; the build step is `npm run build` | `.github/workflows/UNIT-TESTS.yml:39`, `:55-59`, `package.json:30`, `:33`, `.github/workflows/PR-GATE.yml:134-158`, `:160-164` |

## 3. Interfaces (what runs)
- Account `vitana-engineering`, created in AWS Organizations by `setup.sh`. VPC `10.20.0.0/16`, two availability zones.
  Public subnets hold the load balancer only. Private subnets hold both machines. One NAT gateway and an S3 gateway
  endpoint. No peering with the production VPC `10.0.0.0/16`.
- Terraform state: S3 bucket `vitana-engineering-tfstate-<account id>` (versioned, encrypted, public access blocked), locking
  with `use_lockfile`.
- GitLab machine: Ubuntu 24.04, 200 GB encrypted gp3, no public IP, IMDSv2 required with hop limit 1, administration through
  SSM only. GitLab Omnibus pinned to `19.5.3-ee.0`, `external_url 'https://gitlab.vitanaland.com'`, NGINX on port 80 behind
  the load balancer, 4 GB swap. Instance settings: sign-up off, two-factor required (48 hours of grace), usage ping off,
  default visibility private.
- Runner machine: Ubuntu 24.04, 100 GB encrypted gp3, Docker, GitLab Runner `19.5.2` pinned, no public IP, no inbound rule,
  IMDSv2 hop limit 1. Image `public.ecr.aws/docker/library/node:20-bookworm`. Its role may read only its own runner token.
- Load balancer: HTTPS 443, ACM certificate for `gitlab.vitanaland.com` in `eu-central-1`, TLS policy
  `ELBSecurityPolicy-TLS13-1-2-2021-06`, forwarding to GitLab on port 80, health check `/users/sign_in`.
- Security groups: the load balancer accepts 443 from the internet; GitLab accepts 80 from the load balancer only; the runner
  accepts nothing inbound.
- Secrets Manager (KMS key `alias/vitana-engineering`): `vitana/engineering/gitlab/root-password`, `runner-token`,
  `github-mirror-token`.
- Backups: bucket `vitana-engineering-gitlab-backups-<account id>` (SSE-KMS, versioned, objects expire after 30 days). A cron
  job at 02:15 UTC runs `gitlab-backup` and copies the archive and `/etc/gitlab` to the bucket.
- GitLab content: group `vitana` with projects `ci-config`, `vitana-platform`, `vitana-v1`; the mirror user `vitana-mirror`
  (Maintainer on the two mirrored projects, Reporter on `ci-config`).
- Central CI, two files, both only on `main` and on manual, API and schedule runs, every job with the tag `vitana-eng`, no AWS
  credential and no deploy:
  - `platform.gitlab-ci.yml`: Node 20, pnpm 9.0.0, from `services/gateway`: job `typecheck` (`pnpm run typecheck`, premise P6)
    and job `gateway-jest` (4 parallel shards, `npx jest --shard=N/4`, `--maxWorkers=2`). Not ported: the shard-union check, the
    Dev frontend navigation spec validation, every other GitHub workflow.
  - `v1.gitlab-ci.yml`: after `npm ci`, job `unit-tests` (`npm test`: the three guard scripts and `vitest run`), job `build`
    (`npm run build`) and job `lint` (`npm run lint`, reported, allowed to fail). Not ported: the Deno test, the PR-GATE
    ratchets and regression run (premise P9).
- Owner entry point `setup.sh` with `run`, `status`, `password`, `token`, `diag`, `runner`, `grow`; DNS records can be created
  through the Cloudflare API with a token typed hidden and kept only in memory.

## 4. Lane
One lane, `gitlab-infra` (vitana-platform, executor kiro, seat exafy): commits the bundle to `infra/gitlab-engineering/`
exactly as it runs (setup.sh, terraform, host scripts, central CI files), adds `scripts/eng/gitlab-m1-structure.test.mjs`,
`infra/gitlab-engineering/RUNBOOK.md` (owner steps, the restore procedure, how to read `setup.sh status`, and a "Not built yet"
list of the items §10 defers), and the evidence.
It changes no running resource.

## 5. Tests (red on base because the files do not exist there)
`scripts/eng/gitlab-m1-structure.test.mjs`, dependency-free Node (run by `UNIT.yml`), reads the committed files:
- Terraform: both machines have no public IP, require IMDSv2 with hop limit 1, encrypt their volumes; the state backend uses
  `use_lockfile`; the backup and Secrets Manager resources use the KMS key; the GitLab group accepts only the load balancer
  group; the runner group has no ingress rule; the machine sizes are variables; no wildcard action on a wildcard resource
  outside the documented exceptions.
- Scripts: every `*.sh` passes `bash -n`; no `set -x` in a script that handles a secret; the Cloudflare token is read hidden
  and never written to a file; `setup.sh` exports `AWS_REGION` as well as `AWS_DEFAULT_REGION`.
- Central CI files: every job has `tags: [vitana-eng]`; no AWS name; no job runs on branches other than `main`, web, API and
  schedule.
- Real checks recorded in the lane evidence: `terraform fmt -check` and `terraform validate` (Terraform 1.17.1, AWS provider
  5.x), and the commands of §6.

## 6. Done and still to do (owner steps are marked ▶)
Done on 2026-11-04, observed from outside and from the owner's CloudShell output: account created; certificate issued; apply
complete (VPC, load balancer, both machines, buckets, secrets); `https://gitlab.vitanaland.com/users/sign_in` answers 200 with
a valid certificate; GitLab configuration finished with no failures; the runner is registered and verified.
Still to do:
1. ▶ The first green pipeline on `vitana-platform` and on `vitana-v1` (the mirror runs every 5 minutes once the GitHub token is
   stored, which it is). The evidence puts each GitLab job result next to GitHub's result for the same `main` commit
   (`docs/ENGINEERING-PLATFORM-PLAN.md:120` asks for this comparison): TEST-SUITE for the platform, UNIT-TESTS for vitana-v1.
   A difference is recorded, not hidden. If a pipeline fails, the lane fixes the central CI file.
2. ▶ One restore test: create a scratch machine from the latest backup and compare project counts and one commit hash
   (acceptance A04). The runbook gives the commands.
3. ▶ Evidence that the nightly backup ran: `aws s3 ls` of the backup bucket after 02:15 UTC.
4. The lane merges under the pipeline's rules.

## 7. Cost
Two always-on machines, one NAT gateway, one load balancer, about 300 GB of encrypted EBS, S3 for backups, Secrets Manager.
The lane writes the monthly estimate from the AWS price list into its evidence. It is expected to be a few hundred US dollars
per month, less while the machines are at the smaller size.

## 8. Risks
- One GitLab machine is a single point of failure. CI stops if it stops. High availability is a later milestone.
- Secrets in Secrets Manager have a zero-day recovery window (set for easy teardown); a destroyed secret cannot be restored.
  Tighten it once the setup is stable.
- Untrusted code does not run on the runner in milestone 1 (only our own mirrored `main`), and the runner has no AWS
  permission. Both must stay true before agents are allowed to push to GitLab (milestone 2 enforces it).
- The GitHub token used by the mirror is read-only and limited to these two repositories.
- The initial root password was shown in a chat. It must be changed at the first login and two-factor set up.
- A GitLab major upgrade needs its own plan. Milestone 1 stays on the pinned version.

## 9. Staging verification and acceptance
Not verified on staging: no product code path changes (the lane's paths are `infra/`, one test file and `docs/validation/`).
The labels A01 to A05 are the numbering of the owner's original plan; git does not define them (premise P3), so this plan
states each one:

| # | Criterion in this plan | Proof |
|---|---|---|
| A01 | GitLab answers over HTTPS with a valid certificate on `gitlab.vitanaland.com` | observed 2026-11-04: `/users/sign_in` answers 200 |
| A02 | The infrastructure is created by Terraform; after this lane merges it can be rebuilt from git | the owner's apply completed 2026-11-04; the structure test and `terraform validate` once the files are in git |
| A03 | Storage is encrypted and a nightly backup exists in the backup bucket | encryption pinned by the structure test; the backup listing after 02:15 UTC (step 3) |
| A04 | A restore on a scratch machine reproduces the project count and one commit hash | step 2 |
| A05 | The runner is registered and runs jobs | observed 2026-11-04: runner verified; the first pipelines (step 1) |

Plus the first green pipelines on both mirrored projects, compared with GitHub's results (step 1).

## 10. Unchanged, and the items this plan defers
Unchanged: GitHub Actions and every deploy workflow; production; the gateway; production DNS; the production frontend change
(`eng-platform-p02`, paused).

Deferred, with where each is tracked (§2 lists the document lines):
- CloudTrail, Config and Security Hub in the engineering account, RDS and ElastiCache, S3 object storage and AWS Backup:
  not covered by milestone 2 either. They stay in `docs/ENGINEERING-PLATFORM-PLAN.md` Phase 2 (lines 112-113) as open
  items, and the lane's `RUNBOOK.md` lists them under "Not built yet".
- Bot-only `main` protection and the removal of Maintainer force-push on a project: milestone 2, lane `settings` (§3.3
  of `eng-gitlab-m2`, profile `native`); for the two mirrored projects at their cutover.
- The Deno test, the PR-GATE ratchets and the regression run for vitana-v1, and the shard-union check for the platform:
  the milestone that moves each project, with the cutover plan.
<!-- plan:end -->
