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
- Pipelines on the mirrored `main` run the same checks as GitHub's TEST-SUITE and UNIT-TESTS, from a central
  configuration that branches cannot change.
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
- Recovery point 24 hours (nightly backup). Recovery time: a rebuild from Terraform plus a restore, hours not minutes.

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
- Central CI: `platform.gitlab-ci.yml` (Node 20, pnpm 9, typecheck and four Jest shards, as TEST-SUITE) and `v1.gitlab-ci.yml`
  (unit tests and build, lint reported but not blocking). Every job has the tag `vitana-eng`, names no AWS credential and runs
  no deploy.
- Owner entry point `setup.sh` with `run`, `status`, `password`, `token`, `diag`, `runner`, `grow`; DNS records can be created
  through the Cloudflare API with a token typed hidden and kept only in memory.

## 4. Lane
One lane, `gitlab-infra` (vitana-platform, executor kiro, seat exafy): commits the bundle to `infra/gitlab-engineering/`
exactly as it runs (setup.sh, terraform, host scripts, central CI files), adds `scripts/eng/gitlab-m1-structure.test.mjs`,
`infra/gitlab-engineering/RUNBOOK.md` (owner steps, the restore procedure, how to read `setup.sh status`), and the evidence.
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
   stored, which it is). If a pipeline fails, the lane fixes the central CI file.
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
Not verified on staging: no product code path changes. Acceptance for milestone 1: GitLab over HTTPS (A01, observed); Terraform
provisioned (A02, observed); encrypted storage and nightly backup (A03, evidence step 3); restore succeeds (A04, step 2); runner
operational (A05, observed); first green pipelines on both mirrored projects (step 1).

## 10. Unchanged
GitHub Actions and every deploy workflow; production; the gateway; production DNS; the production frontend change
(`eng-platform-p02`, paused).
<!-- plan:end -->
