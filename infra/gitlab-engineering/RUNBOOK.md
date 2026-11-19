# Self-hosted GitLab CI, milestone 1: runbook

Plan: `.kiro/specs/eng-gitlab-m1/plan.md`. This file says what runs, what the owner types in AWS CloudShell, how to read the
output, and how to prove the two checks that are still open: green pipelines on the mirrored projects and one restore from
backup. Everything here is run by the owner, because only the owner has AWS rights (decision D5 of
`docs/ENGINEERING-PLATFORM-PLAN.md`). Agents write and review; they never apply.

## 1. What runs

| Thing | Value |
|---|---|
| URL | `https://gitlab.vitanaland.com` (GitLab EE `19.5.3-ee.0`, no licence, Free tier) |
| AWS account | `vitana-engineering` (id in `~/vitana-eng/state.env`, line `ACCOUNT_ID=`), region `eu-central-1` |
| Machines | `vitana-eng-gitlab` (200 GB) and `vitana-eng-runner` (100 GB), both in private subnets, no public IP, reached only through SSM |
| Way in | HTTPS load balancer `vitana-eng-gitlab`, ACM certificate, TLS 1.3 policy; DNS in Cloudflare (DNS only, grey cloud) |
| Runner | one Docker runner `vitana-eng-1`, tag `vitana-eng`, image `public.ecr.aws/docker/library/node:20-bookworm` |
| GitLab content | group `vitana`: projects `ci-config`, `vitana-platform`, `vitana-v1`; user `vitana-mirror` |
| Mirror | systemd timer `vitana-mirror.timer` on the GitLab machine, every 5 minutes, GitHub to GitLab only |
| Backups | cron 02:15 UTC to the bucket `vitana-engineering-gitlab-backups-<account id>` |
| Secrets | Secrets Manager `vitana/engineering/gitlab/root-password`, `runner-token`, `github-mirror-token` (key `alias/vitana-engineering`) |
| Terraform state | bucket `vitana-engineering-tfstate-<account id>`, lock file next to the state |

Files in this folder: `setup.sh` (the owner's entry point), `terraform/main.tf`, `host/*.sh` and `host/*.yml` (copied onto the
machines at first boot), this file.

Terraform ignores later changes to a machine's user data (`lifecycle { ignore_changes = [ami, user_data_base64] }`), so editing a file
under `host/` and applying changes nothing on a machine that is already running. A changed host file reaches a running machine only when
the owner copies it there (section 6, step 0, does this for the platform CI file) or when the machine is rebuilt.

## 2. The owner's commands (CloudShell, signed in to the management account 472838866351)

**Get the folder into CloudShell.** `setup.sh` runs from `~/vitana-eng/` and writes `state.env` next to itself (account id, load balancer name,
instance ids). To use the copy in git (a rebuild, or a newer version), zip the contents of the folder `infra/gitlab-engineering` (so that
`setup.sh` is at the top of the zip) on a computer that has the repository, upload the zip with CloudShell's Actions menu (Upload file), and
run `mkdir -p ~/vitana-eng && unzip -o <the zip> -d ~/vitana-eng`. Keep an existing `state.env`. Without one, `setup.sh` finds the account
`vitana-engineering` by name (it creates one only when none exists), the certificate by domain and the machines by name, and Terraform's state
is in the bucket `vitana-engineering-tfstate-<account id>`, so a rebuild continues from it.

`bash ~/vitana-eng/setup.sh` followed by:

| Word | What it does |
|---|---|
| (none) or `run` | Creates the AWS account once, the certificate, and the infrastructure. Asks once for a Cloudflare token (typed hidden, kept in memory) and creates the two DNS records; press Enter to get the records printed instead. Safe to run again. |
| `status` | Shows how far the GitLab machine and the runner machine are (section 3). |
| `password` | Prints the GitLab `root` password from Secrets Manager. |
| `token` | Stores the GitHub read-only token for the mirror (section 5). |
| `diag` | Lists which AWS services of the new account AWS has activated yet. |
| `runner` | Registers the CI runner again if its first registration did not happen (waits up to 30 minutes for DNS). |
| `grow` | Moves both machines to full size (`m6i.xlarge`) after AWS has raised the EC2 vCPU limit. GitLab restarts: a few minutes of downtime. |

Use the engineering account yourself (for the `aws` commands below). The credentials last one hour and live only in that shell:

```bash
ACCOUNT_ID=$(grep '^ACCOUNT_ID=' ~/vitana-eng/state.env | cut -d= -f2)
C=$(aws sts assume-role --role-arn arn:aws:iam::$ACCOUNT_ID:role/OrganizationAccountAccessRole --role-session-name vitana-eng --query Credentials --output json)
export AWS_ACCESS_KEY_ID=$(jq -r .AccessKeyId <<<"$C") AWS_SECRET_ACCESS_KEY=$(jq -r .SecretAccessKey <<<"$C") AWS_SESSION_TOKEN=$(jq -r .SessionToken <<<"$C")
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1   # CloudShell sets AWS_REGION itself, and the CLI prefers it
```

## 3. Reading `setup.sh status`

Good:
- GitLab machine: the last line of the log block reads `done failures=0 <time>`, and `gitlab-ctl status` lists `run:` lines.
- Runner machine: `Verifying runner... is alive` (or `is valid`) and the log ends with `== runner install done`.

Not good:
- `failures=N` with N above 0: the lines that start with `!!` in `/var/log/vitana-bootstrap.log` on the GitLab machine name the step. The configure step is safe to run again.
- `register attempt N failed, retrying`: the runner machine cannot resolve or reach `gitlab.vitanaland.com` yet (DNS record missing or cached). Fix the record, wait a few minutes, run `setup.sh runner`.
- `no runner token after 2 hours`: the GitLab machine did not finish. Read its log first.
- `(SSM not ready ...)`: the machine has not registered with Systems Manager yet; wait two minutes.

## 4. First login

User `root`, password from `setup.sh password`. The first password was shown in a chat, so change it at the first login and set up
two-factor authentication within 48 hours (the instance requires it after that grace period). Sign-up is off; new users are
created by an administrator.

## 5. The mirror

The mirror copies `exafyltd/vitana-platform` and `exafyltd/vitana-v1` from GitHub into the GitLab projects of the same names every
5 minutes. GitHub stays the source of truth. It idles until the token is stored:

1. GitHub, Settings, Developer settings, Fine-grained tokens: repositories `exafyltd/vitana-platform` and `exafyltd/vitana-v1` only,
   permissions Contents: Read-only and Metadata: Read-only.
2. `bash ~/vitana-eng/setup.sh token`, paste the token (hidden). It goes to Secrets Manager only.

The mirror forces every branch and tag to match GitHub and deletes anything that exists only in GitLab. **Nobody pushes to the
mirrored projects in GitLab in milestone 1**: the next mirror run would overwrite or delete it.

## 6. First green pipelines (plan section 6, steps 0 and 1)

Pipelines run for `main` of each mirrored project (and for a manual "Run pipeline" on `main`), from the central files in the project
`vitana/ci-config` (`platform.gitlab-ci.yml`, `v1.gitlab-ci.yml`). The first pipeline of each project is started by the mirror.

**Step 0, before reading any result: put the corrected platform file into GitLab.** The file that ran first installed the gateway with
`pnpm install`, which fails the type check (TS2664 on two `declare module 'express-serve-static-core'` blocks; plan premise P10). In GitLab,
signed in as `root`: project `vitana/ci-config`, file `platform.gitlab-ci.yml`, Edit, select everything, paste the file below, commit to
`main`. It is identical to `host/ci-platform.yml` in this folder (a test pins that):

```yaml
# Central CI config for exafyltd/vitana-platform. Lives in the GitLab project vitana/ci-config; the mirrored project
# points at it (ci_config_path), so an application branch cannot change the pipeline that checks it.
# Mirrors the GitHub TEST-SUITE gateway job: pnpm 9, Node 20, 4 Jest shards. Runs on main, and on manual/API runs.
workflow:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
    - if: $CI_PIPELINE_SOURCE =~ /^(web|api|schedule)$/

default:
  tags: [vitana-eng]
  image: public.ecr.aws/docker/library/node:20-bookworm
  interruptible: true

stages: [check]

variables:
  NODE_ENV: test
  CI: "true"

.gateway:
  timeout: 40m
  cache:
    key:
      files: [pnpm-lock.yaml]
    paths: [.pnpm-store]
  before_script:
    - npm install -g pnpm@9.0.0
    - pnpm config set store-dir "$CI_PROJECT_DIR/.pnpm-store"
    - cd services/gateway

# Same install as GitHub's gateway type check (CICDL-GATEWAY-CI.yml: `npm ci` in services/gateway, then `pnpm run typecheck`).
# With `pnpm install` here tsc fails on two `declare module 'express-serve-static-core'` augmentations (TS2664): pnpm's strict
# node_modules layout hides that transitive type package. Checked on the base commit: npm ci then pnpm run typecheck = 0 errors.
typecheck:
  extends: .gateway
  stage: check
  variables:
    NODE_OPTIONS: "--max-old-space-size=6144"
  script:
    - npm ci --no-audit --no-fund
    - pnpm run typecheck

gateway-jest:
  extends: .gateway
  stage: check
  parallel: 4
  variables:
    NODE_OPTIONS: "--max-old-space-size=3072"
  script:
    # Same install as TEST-SUITE.yml (pnpm install --frozen-lockfile in services/gateway).
    - pnpm install --frozen-lockfile
    - npx jest --silent --maxWorkers=2 --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL
```

Then start a pipeline on `vitana/vitana-platform` (Build, Pipelines, Run pipeline, branch `main`).

**Do not run `gitlab-configure.sh` again afterwards.** It copies `/opt/vitana/ci-platform.yml` (the old text) over the file you just edited.
If it has to run, first replace `/opt/vitana/ci-platform.yml` on the GitLab machine with the corrected text.

**Step 1: read the results.**

- Platform: jobs `typecheck` and `gateway-jest` (4 shards). GitHub's results to compare:
  `gh run list --repo exafyltd/vitana-platform --workflow TEST-SUITE.yml --branch main --limit 3`.
- vitana-v1: jobs `unit-tests` and `build`; `lint` may fail. GitHub's results to compare:
  `gh run list --repo exafyltd/vitana-v1 --workflow UNIT-TESTS.yml --branch main --limit 3`.

Evidence for the lane: for the same `main` commit, each GitLab job result next to GitHub's result, and a note for every difference.
A difference is recorded, not hidden. A failing job means the central file needs a fix: edit it in the GitLab project `vitana/ci-config`
(Edit file, commit to `main`) and change the same file in git in the same pull request, because in milestone 1 nothing copies git to the
running host (the machines' first-boot data is ignored by Terraform after creation). Milestone 2 (`eng-gitlab-m2`, lane `settings`)
makes git the source for these files.

## 7. Backups (A03)

What a backup is: at 02:15 UTC `/opt/vitana/backup.sh` runs `gitlab-backup create CRON=1 STRATEGY=copy`, copies the archive to
`s3://<bucket>/backups/<id>_gitlab_backup.tar`, and copies `/etc/gitlab` (this holds `gitlab-secrets.json`, which a restore needs) to
`s3://<bucket>/config/gitlab-config-<date>.tgz`. One backup also runs when the machine is first configured. The bucket is encrypted with
the engineering key, versioned, blocks public access, refuses non-TLS requests, and expires objects after 30 days. The GitLab machine
keeps its local copy for one day.

Evidence (after 02:15 UTC, with the engineering-account credentials of section 2):

```bash
BUCKET=vitana-engineering-gitlab-backups-$ACCOUNT_ID
aws s3 ls s3://$BUCKET/backups/ --human-readable
aws s3 ls s3://$BUCKET/config/ --human-readable
```

Recovery point: 24 hours. Recovery time: a rebuild from Terraform plus a restore, hours not minutes.

## 8. Restore test (A04): not run yet

The test restores the latest backup on a scratch machine that is not behind the load balancer, then compares it with the live GitLab.
GitLab's own rules: the same version and type (`19.5.3-ee.0`), the secrets file restored first, `puma` and `sidekiq` stopped
during the restore. The commands below follow those rules and the S3 layout of section 7. They have not been run; the first run is the
evidence, and a command that fails is fixed in this file.

Step B uses the variable `BUCKET` from section 7. Set it again if this is a new shell (engineering-account credentials, section 2):

```bash
ACCOUNT_ID=$(grep '^ACCOUNT_ID=' ~/vitana-eng/state.env | cut -d= -f2)
BUCKET=vitana-engineering-gitlab-backups-$ACCOUNT_ID
```

Step C uses `TIP`, which the last line of step B sets from the result. If you come back to step C in a new shell, set `TIP` to the
`RESULT-MAIN-TIP:` value you kept.

**A. Launch the scratch machine** (engineering-account credentials, section 2). It uses the runner's security group, which accepts
nothing inbound, and the GitLab machine's role, which can read the backup bucket:

```bash
AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=vitana-eng-private-1 --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=vitana-eng-runner --query 'SecurityGroups[0].GroupId' --output text)
SCRATCH=$(aws ec2 run-instances --image-id "$AMI" --instance-type m6i.xlarge --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --iam-instance-profile Name=vitana-eng-gitlab \
  --metadata-options HttpEndpoint=enabled,HttpTokens=required,HttpPutResponseHopLimit=1 \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3,Encrypted=true,KmsKeyId=alias/vitana-engineering}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=vitana-eng-restore-test}]' \
  --query 'Instances[0].InstanceId' --output text); echo "scratch machine: $SCRATCH"
aws ec2 wait instance-running --instance-ids "$SCRATCH"
```

If this stops with `VcpuLimitExceeded`, the account's EC2 vCPU limit is used up by the two machines: either use `--instance-type m6i.large`
(2 vCPUs, enough for a restore) or ask AWS to raise the limit (Service Quotas, EC2, "Running On-Demand Standard instances"; `setup.sh grow` explains the same limit). Wait until the machine answers
Systems Manager: `aws ssm describe-instance-information --filters Key=InstanceIds,Values=$SCRATCH --query 'InstanceInformationList[0].PingStatus'`
prints `Online`.

**B. Restore on the scratch machine** (20 to 40 minutes). The script is sent as a base64 file and started with `bash` explicitly, because
Run Command starts plain `sh` otherwise. Run Command shows only the first 24,000 characters of output, so the script writes everything to
`/var/log/restore-test.log` on the scratch machine and shows only its `say` lines:

```bash
cat > restore-inner.sh <<'EOF'
#!/bin/bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive HOME=/root AWS_DEFAULT_REGION=eu-central-1
GITLAB_VERSION=19.5.3-ee.0
exec 3>&1                                     # fd 3 is what Run Command shows
exec >>/var/log/restore-test.log 2>&1         # everything else goes to the log on this machine
say() { echo "$*"; echo "$*" >&3; }
fail() { say "RESULT: FAIL $*"; exit 1; }
say "== restore test start $(date -u +%FT%TZ)"
apt-get -o DPkg::Lock::Timeout=900 update -y
apt-get -o DPkg::Lock::Timeout=900 install -y curl ca-certificates unzip jq git openssh-server perl tzdata gnupg
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip && unzip -q -o /tmp/awscliv2.zip -d /tmp && /tmp/aws/install
fi
BK=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix backups/ --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
CF=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix config/ --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
say "backup: $BK   config: $CF"
{ [ -n "$BK" ] && [ "$BK" != None ] && [ -n "$CF" ] && [ "$CF" != None ]; } || fail "no backup or no config archive in the bucket"
mkdir -p /root/restore
aws s3 cp "s3://$BUCKET/$BK" /root/restore/ && aws s3 cp "s3://$BUCKET/$CF" /root/restore/ || fail "download"
tar -xzf "/root/restore/$(basename "$CF")" -C /     # /etc/gitlab first: gitlab.rb and gitlab-secrets.json (GitLab asks for the secrets before the restore)
curl -fsSL https://packages.gitlab.com/install/repositories/gitlab/gitlab-ee/script.deb.sh | bash
apt-get -o DPkg::Lock::Timeout=900 install -y "gitlab-ee=$GITLAB_VERSION" || fail "install of gitlab-ee=$GITLAB_VERSION"
gitlab-ctl reconfigure || fail "first reconfigure"
FILE="$(basename "$BK")"; ID="${FILE%_gitlab_backup.tar}"
cp "/root/restore/$FILE" /var/opt/gitlab/backups/ && chown git:git "/var/opt/gitlab/backups/$FILE" || fail "backup file placement"
gitlab-ctl stop puma; gitlab-ctl stop sidekiq
GITLAB_ASSUME_YES=1 gitlab-backup restore BACKUP="$ID" || fail "gitlab-backup restore $ID"
gitlab-ctl reconfigure && gitlab-ctl restart || fail "reconfigure or restart after the restore"
sleep 60
say "doctor:secrets: $(gitlab-rake gitlab:doctor:secrets 2>&1 | tail -3 | tr '\n' ' ')"
cat > /tmp/result.rb <<'RB'   # /tmp: gitlab-rails runner runs as user git, which cannot read /root
p = Project.find_by_full_path('vitana/vitana-platform')
puts "RESULT-COUNTS: #{[Project.count, Group.count, User.count].join(' ')}"
puts "RESULT-MAIN-TIP: #{p ? (p.repository.commit('main')&.id || 'none') : 'none'}"
RB
for n in 1 2 3; do   # the first runner after a restore can fail while GitLab finishes starting; keep its error, never hide it
  chmod 644 /tmp/result.rb; gitlab-rails runner /tmp/result.rb >/root/result.out 2>/root/result.err && grep -q '^RESULT-COUNTS:' /root/result.out && break
  sleep 60
done
grep '^RESULT-' /root/result.out | while IFS= read -r l; do say "$l"; done
grep -q '^RESULT-COUNTS:' /root/result.out || fail "result query: $(tail -5 /root/result.err | tr '\n' ' ')"
say "RESULT: DONE $ID"
EOF
bash -n restore-inner.sh && echo "script syntax ok"

CMD=$(jq -nc --arg c "echo $(base64 -w0 restore-inner.sh) | base64 -d > /root/restore-inner.sh && BUCKET=$BUCKET bash /root/restore-inner.sh" '{commands:[$c],executionTimeout:["7200"]}')
CID=$(aws ssm send-command --instance-ids "$SCRATCH" --document-name AWS-RunShellScript --parameters "$CMD" --query Command.CommandId --output text)
echo "command id: $CID   (if CloudShell closes, the machine keeps working: read the result later with get-command-invocation and this id)"
while :; do
  S=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$SCRATCH" --query Status --output text 2>/dev/null)
  case "$S" in Pending|InProgress|Delayed|"") printf .; sleep 30 ;; *) break ;; esac
done
echo; echo "status: $S"
OUT=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$SCRATCH" --query StandardOutputContent --output text); echo "$OUT"
aws ssm get-command-invocation --command-id "$CID" --instance-id "$SCRATCH" --query StandardErrorContent --output text | tail -5
TIP=$(sed -n 's/^RESULT-MAIN-TIP: //p' <<<"$OUT" | head -1)
```

The lines to keep as evidence: `backup:`, `doctor:secrets:`, `RESULT-COUNTS:`, `RESULT-MAIN-TIP:` and `RESULT: DONE <backup id>`. A `RESULT: FAIL` line names
the step. The full log is `/var/log/restore-test.log` on the scratch machine (read it through Systems Manager before step D).

**C. Compare with the live GitLab** (read only: one Ruby file that only counts and looks up a commit):

```bash
cat > live-check.rb <<'EOF'
tip = ENV['TIP'].to_s
p = Project.find_by_full_path('vitana/vitana-platform')
puts "LIVE-COUNTS: #{[Project.count, Group.count, User.count].join(' ')}"
puts "LIVE-HAS-TIP: #{(tip.empty? || tip == 'none') ? 'no tip to check (step B gave no RESULT-MAIN-TIP)' : (!p.nil? && !p.repository.commit(tip).nil?)}"
EOF
LIVE=$(aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-gitlab Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
Q=$(jq -nc --arg c "echo $(base64 -w0 live-check.rb) | base64 -d > /tmp/live-check.rb && TIP=$TIP gitlab-rails runner /tmp/live-check.rb 2>/tmp/live-check.err | grep '^LIVE-' || tail -5 /tmp/live-check.err; rm -f /tmp/live-check.rb /tmp/live-check.err" '{commands:[$c]}')
QID=$(aws ssm send-command --instance-ids "$LIVE" --document-name AWS-RunShellScript --parameters "$Q" --query Command.CommandId --output text)
while :; do
  S=$(aws ssm get-command-invocation --command-id "$QID" --instance-id "$LIVE" --query Status --output text 2>/dev/null)
  case "$S" in Pending|InProgress|Delayed|"") printf .; sleep 5 ;; *) break ;; esac
done
echo; echo "status: $S"; aws ssm get-command-invocation --command-id "$QID" --instance-id "$LIVE" --query StandardOutputContent --output text
```

A04 holds when `LIVE-COUNTS` equals `RESULT-COUNTS` (projects, groups, users) and `LIVE-HAS-TIP` is `true`: the live project knows the commit that
the restored `main` pointed at. Live counts above the restored ones are fine only if something was created after the backup was taken; say
what in the evidence. Paste the output of B and C into the lane evidence.

**D. Remove the scratch machine** (always, also when a step failed):

```bash
aws ec2 terminate-instances --instance-ids "$SCRATCH" --query 'TerminatingInstances[0].CurrentState.Name' --output text
aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-restore-test Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text
```

The second command must print nothing. The scratch machine has no mirror timer and no backup cron (neither is part of the backup), so
nothing on it talks to GitHub or writes to the backup bucket by itself. Its role is the GitLab machine's role, which can read and write the
backup bucket and write the two generated secrets, and it holds a copy of GitLab's data and secrets: treat it like the live machine until it
is gone.

## 9. Dates that matter

- The bootstrap administrator token on the GitLab machine (`/etc/vitana/bootstrap-pat`, readable by root only) expires 7 days after
  the machine's first configuration. Nothing needs it afterwards.
- The mirror's GitLab token (`/etc/vitana/mirror-token`, user `vitana-mirror`) is valid for 360 days from the first configuration
  (2026-11-04), so until about 2027-10-30. Replace it before then: the mirror stops with `mirror token missing` or an authentication error.
- The GitHub token for the mirror expires on the date chosen when it was created (section 5).
- The two-factor grace period for the first administrator is 48 hours.

## 10. Not built yet

These are named in `docs/ENGINEERING-PLATFORM-PLAN.md` (Phase 2 and Phase 3, lines 111 to 122) and are not part of milestone 1:

- CloudTrail, Config and Security Hub in the engineering account.
- RDS PostgreSQL and ElastiCache Redis (GitLab uses its built-in database and Redis on the GitLab machine) and S3 object storage (uploads
  and artifacts stay on the 200 GB volume).
- AWS Backup. The nightly `gitlab-backup` copy in S3 is the only backup.
- Bot-only protection of `main`. In milestone 1 the mirror user writes `main`, and the instance default lets Maintainers push and
  force-push. Milestone 2 (`eng-gitlab-m2`, lane `settings`) replaces this for projects that agents work in.
- The GitHub checks the central CI files do not run: for the platform, the shard-union check and the Dev frontend navigation spec
  validation; for vitana-v1, the Deno test of the edge data client and the PR-GATE ratchets and regression run.
- Autoscaling runners, merge control, agent accounts, deploy jobs, high availability. See `eng-gitlab-m2` and later plans.
- Teardown is not scripted: the secrets have a zero-day recovery window, and the backup bucket is versioned and must be emptied by hand
  before it can be deleted.
