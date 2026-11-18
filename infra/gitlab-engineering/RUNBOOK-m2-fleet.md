# Self-hosted GitLab CI, milestone 2: the job fleet (runbook)

Plan `eng-gitlab-m2`, section 3.2, lane `fleet`. Terraform: `terraform/fleet.tf`, `terraform/fleet-ami.tf`. Files on the machines: `host/fleet-manager-install.sh`,
`host/fleet-image/component.yml`. Milestone 1 (`RUNBOOK.md`) is unchanged and is read first.

**Status: written, validated and tested without AWS. It has not run in the engineering account.** The fleet, the machine image build and the
runner plugin have never run there. The rehearsal (plan section 3.8, acceptance A1 and A2) is what finds out whether they work. Where this
document says what a symptom means, it is what the AWS and GitLab documentation say, not something seen on this fleet yet.

## 1. What it is

| Part | What it does |
|---|---|
| Auto Scaling group `vitana-eng-fleet` | 0 machines until the runner asks for one. Size 0 to `fleet_max_instances` (24). Nothing else scales it. |
| Job machine | One per CI job, deleted after that job. `m6i`, `m6a`, `m5` or `m5a` `.xlarge` (4 vCPU, 16 GB), 80 % Spot. 100 GB encrypted disk. In a private subnet, no public address. No AWS permission and no secret on it. |
| Fleet manager `vitana-eng-fleet-manager` | A `t3.medium` that runs the GitLab Runner and the AWS plugin. It is the only thing that starts and deletes job machines. No Docker, no job runs on it. |
| Machine image | Built by EC2 Image Builder: Ubuntu 24.04, Docker Engine, the Node 20 job image and the runner helper image already pulled. |
| Cache bucket `vitana-engineering-ci-cache-<account id>` | The CI cache. Encrypted with the engineering key, objects expire after 7 days. |
| Secret `vitana/engineering/gitlab/fleet-runner-token` | Created empty. The settings sync (lane `settings`) writes the runner's token here; the manager waits for it. |

The new files are next to milestone 1's `main.tf` and use its network, key and naming. `main.tf` is not edited. Every variable has a default,
so the same `setup.sh` command applies them. No new `-var` flag.

## 2. Quota: raise it before the apply

A new AWS account starts with low vCPU limits. The fleet needs `fleet_max_instances x 4` vCPUs (96 at the default of 24) in **both**
"Standard" quotas: On-Demand and Spot. The Terraform plan **stops by itself, before it creates anything of the fleet,** when either is too low,
and prints the commands below with the numbers filled in.

Look at the current values (in the engineering account, see section 2 of `RUNBOOK.md` for the one-hour credentials):

```bash
aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query 'Quota.[QuotaName,Value]' --output text
aws service-quotas list-service-quotas --service-code ec2 --query "Quotas[?starts_with(QuotaName, 'All Standard') && contains(QuotaName, 'Spot')].[QuotaCode,QuotaName,Value]" --output text
```

Ask for the increase. The On-Demand code `L-1216C47A` is "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" (AWS CLI
documentation). The Spot quota is "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests": Terraform looks it up by that name and
prints the code AWS returns, and the second command above shows it too. Use the printed lines; for the default size they read:

```bash
aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 96 --region eu-central-1
aws service-quotas request-service-quota-increase --service-code ec2 --quota-code <the Spot code from the list command> --desired-value 96 --region eu-central-1
```

AWS usually answers within hours, for a new account sometimes a day. Check with `aws service-quotas list-requested-service-quota-change-history-by-quota --service-code ec2 --quota-code L-1216C47A`.
The plan keeps stopping until the value has really been raised. The always-on machines of milestone 1 (GitLab 4 vCPU, runner 4) and the
manager (2) also use the On-Demand quota; at the default 80 % Spot the fleet uses about a fifth of its limit On-Demand, so 96 leaves room.
A smaller fleet needs less: `terraform` variable `fleet_max_instances`, section 6.
Fleet size in use since 2026-11-07: 5 machines (owner instruction; 32 vCPUs per Standard quota, requests to 100 filed). Keep
`fleet_max_instances = 5` in `~/vitana-eng/terraform/terraform.tfvars`: without it the next apply sets the group back to 1.

While AWS raises the quota, a smaller fleet lets the rest of milestone 2 apply now: put `fleet_max_instances = 1` (4 vCPUs in each quota) in `~/vitana-eng/terraform/terraform.tfvars`, next to `main.tf`,
and set `fleet_alarm_running_jobs` (the at-maximum alarm of the monitoring file) to the same number, or that alarm never fires. Raise both when the quota is granted. Acceptance A1 of the rehearsal needs the full 24.

## 3. The apply

```bash
bash ~/vitana-eng/setup.sh
```

The same command as milestone 1 (get the newer folder into CloudShell first, section 2 of `RUNBOOK.md`). About 30 minutes, most of it the image
build.

**Keep the CloudShell tab active.** CloudShell ends a session after 20 to 30 minutes without keyboard or pointer input, and a running command does not count as input: press Enter in the tab every ten minutes while the image builds.
`setup.sh` also runs Terraform under credentials that last one hour. If the run ends with `ExpiredToken`, an image timeout or a state lock error ("Error acquiring the state lock"), nothing is lost. With no apply running, clear the lock with the engineering-account credentials of `RUNBOOK.md` section 2 and run the same command again:

```bash
aws s3 rm s3://vitana-engineering-tfstate-$ACCOUNT_ID/gitlab-engineering/terraform.tfstate.tflock
```

An image that a cut-off run had half built is not known to Terraform; Image Builder keeps it and the next run builds another. If the apply says `AWSServiceRoleForEC2Spot has been taken`, the account already has the Spot role: add `fleet_create_spot_service_role = false` to `terraform.tfvars` and run again. What happens, in order:

1. The quota check (section 2). If it stops the apply, nothing of the fleet exists yet; raise the quota and run the command again.
2. The service-linked roles and the **key grants**: the Auto Scaling and Spot roles of AWS get access to the engineering key. Without these,
   the first machine would fail to start with `Client.InternalError` (section 4), because the key has its default policy.
3. The network groups, roles, the empty secret, the cache bucket.
4. **The image build** (20 to 30 minutes, Terraform waits). It builds a machine, installs, then starts a second machine from the new image and checks it
   (Docker, the group of the `ubuntu` user, both images present, no runner binary). **If the build or the check fails the apply fails here, and the group,
   the launch template and the manager are not created.** Read the failure in the EC2 Image Builder console (Images, `vitana-eng-fleet-...`), fix the
   cause, run the command again.
5. The launch template, the group (size 0) and the manager. The manager installs the runner and then **waits** for the token (next).

The fleet does nothing yet: the runner token is created by the settings sync (lane `settings`, rollout step 5). The manager waits for it up to 24 hours,
writes `config.toml`, installs the plugin with `gitlab-runner fleeting install` and starts the runner. Read the manager's progress (no SSH, no key):

```bash
MGR=$(aws ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-fleet-manager Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text)
CID=$(aws ssm send-command --instance-ids "$MGR" --document-name AWS-RunShellScript --parameters 'commands=["tail -n 25 /var/log/vitana-bootstrap.log"]' --query Command.CommandId --output text)
sleep 5; aws ssm get-command-invocation --command-id "$CID" --instance-id "$MGR" --query StandardOutputContent --output text
```

`== fleet manager install done` is the good end. `waiting for the runner token in vitana/engineering/gitlab/fleet-runner-token` means the settings sync has not
written it yet. If the manager gave up (`no runner token after 24 hours`) or the token changed, run the installer again on it:
`bash /opt/vitana/fleet-manager-install.sh >> /var/log/vitana-bootstrap.log 2>&1` (it is safe to repeat).

If the log ends with `gitlab-runner : Depends: gitlab-runner-helper-images (= <version>) but <newer> is to be installed`, the installer
predates the helper pin: install both at the runner version first, `apt-get install -y gitlab-runner-helper-images=<version>
gitlab-runner=<version>`, then run the installer again. Done on the running manager on 2026-11-07 (runner verified 18:05Z).

## 4. When a job waits (what to read, in this order)

"Waiting" means GitLab shows the job as pending, stuck, or "waiting for a runner". First: is it really waiting, or only booting? A job on an empty fleet waits
about a minute and a half for its machine (boot, Docker, SSH). Longer than five minutes is a fault.

1. **GitLab: Admin > CI/CD > Runners.** Is `vitana-eng-fleet` online and not paused? Offline means the manager is not running the runner: go to step 3.
   Does the job's tag match? The central CI uses the tag `vitana-eng`, which the fleet runner has.
2. **Is the fleet at its maximum?** All 24 machines busy is not a fault: jobs wait in the queue until a machine is free (`concurrent` is 24). Count them:
   `aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names vitana-eng-fleet --query 'AutoScalingGroups[0].[DesiredCapacity,MaxSize,Instances[].InstanceId]' --output json`.
3. **The manager.** `journalctl -u gitlab-runner --since "15 min ago"` on the manager (use the `ssm send-command` pattern of section 3), and
   `gitlab-runner fleeting list` (which plugin version runs). Look for: `plugin` not found (the plugin did not install: run the installer again), `unable to acquire instance`,
   `instance unexpectedly removed`, an AWS `AccessDenied` (the manager's role is the exact list in `fleet.tf`; nothing else is allowed).
4. **The group's own log, the most useful one:**
   `aws autoscaling describe-scaling-activities --auto-scaling-group-name vitana-eng-fleet --max-items 10 --query 'Activities[].[StartTime,StatusCode,StatusMessage]' --output text`

| What the activity says | Meaning | What to do |
|---|---|---|
| `VcpuLimitExceeded` or `Max spot instance count exceeded` | The quota (section 2) is too low, or the account's other machines use it | Raise the quota. Check the always-on machines. |
| `Client.InternalError: Client error on launch` or `Client.InvalidKMSKey.InvalidState` | The service-linked role cannot use the engineering key | The grants of section 3 step 2 are missing or still propagating (a few minutes). `aws kms list-grants --key-id $(aws kms describe-key --key-id alias/vitana-engineering --query KeyMetadata.KeyId --output text)` lists them: grantees `AWSServiceRoleForAutoScaling_vitana-eng-fleet` and `AWSServiceRoleForEC2Spot`. Run the apply again. |
| `InsufficientInstanceCapacity` or `There is no Spot capacity available` | AWS has no machine of these types right now | Wait. The group tries four types in both subnets. If it lasts, lower `fleet_spot_percent` (section 6). |
| `The requested configuration is currently not supported` | A type is not offered in a subnet's zone | Not expected for these four types; read the full message and tell the next session. |
| No activity at all, desired size 0 | The manager has not asked for a machine | Step 3. |
| A machine appears and disappears within a minute | The manager cannot connect to it | Step 5. |

5. **The manager cannot connect to a machine.** The connection is SSH over a one-time key sent through EC2 Instance Connect, from the manager group to port 22 of the
   job group. Check the machine: `aws ec2 describe-instances --filters Name=tag:aws:autoscaling:groupName,Values=vitana-eng-fleet --query 'Reservations[].Instances[].[InstanceId,State.Name,PrivateIpAddress]' --output text`, then
   its console output `aws ec2 get-console-output --instance-id <id> --latest --output text | tail -40`. A machine that never reaches the network is a security group or image problem.
   There is no shell on a job machine for you: it has no instance profile policy and no stored key, by design.
6. **A job failed with `ssh tunnel: EOF` or `instance unexpectedly removed`:** a Spot interruption, or someone deleted the machine. The central CI configuration retries such jobs once
   (lane `settings`, `retry` on `runner_system_failure`); a second failure is a real fault.

## 5. How to drain the fleet (stop CI without losing a job)

Use this before maintenance, an image change you want to apply at once, or when costs run away. Nothing here needs Terraform.

```bash
# 1. In GitLab: Admin > CI/CD > Runners > vitana-eng-fleet > Pause. No new job starts; running jobs finish.
# 2. Wait until the running jobs are done (or cancel them in GitLab):
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names vitana-eng-fleet --query 'AutoScalingGroups[0].Instances[].InstanceId' --output text
# 3. Delete what is left. Scale-in protection does not stop this call; it also lowers the desired size so nothing is started again:
for i in $(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names vitana-eng-fleet --query 'AutoScalingGroups[0].Instances[].InstanceId' --output text); do
  aws autoscaling terminate-instance-in-auto-scaling-group --instance-id "$i" --should-decrement-desired-capacity
done
# 4. Stop it from starting more even if the runner is unpaused by mistake:
aws autoscaling update-auto-scaling-group --auto-scaling-group-name vitana-eng-fleet --max-size 0
```

To start again: `aws autoscaling update-auto-scaling-group --auto-scaling-group-name vitana-eng-fleet --max-size 24` (the value of `fleet_max_instances`) and unpause the runner in GitLab.
Terraform does not reset `desired_capacity`, but it does reset `max_size` to `fleet_max_instances` at the next apply. To remove the fleet completely, delete `fleet.tf` and `fleet-ami.tf` (and the host files only they use) in a pull request and apply. **Do not run a bare `terraform destroy`:** the fleet files share one module and one state with `main.tf`, so it would plan to delete the GitLab machine, the runner, the network and the key as well. With machines present the group is force-deleted (scale-in protection does not block it); the empty runner-token secret and the cache bucket go with it, and a non-empty bucket must be emptied first.

## 6. Changing the size or the mix

The variables (`fleet_max_instances`, `fleet_idle_count`, `fleet_spot_percent`, `fleet_image_revision`, `fleet_create_spot_service_role`) have defaults; to change one, add `-var name=value` to the `terraform apply` line in
`setup.sh` of your CloudShell copy, or put it in a `terraform.tfvars` file next to `fleet.tf`. The group changes at once. **The manager's `config.toml` does not**, because a machine's
start-up script is never re-run by an apply (the same rule as milestone 1's machines). After changing `fleet_max_instances` or `fleet_idle_count`, tell the manager: write the new value into
`/etc/vitana/env` on it (`FLEET_MAX_INSTANCES=`, `FLEET_IDLE_COUNT=`) with `ssm send-command`, then run the installer again (section 3). Changing `fleet_max_instances` also needs the quota of section 2.

`fleet_image_revision` (a text, default `1`): change it to build a new machine image on purpose, for example to get newer Ubuntu packages. A newer Canonical image alone never rebuilds anything.
The new image is used for the **next** machine the group starts. The old Image Builder resources are removed; the old AMI and its snapshot stay and cost cents: deregister them in the EC2 console when no job uses them.

The runner plugin is installed as `aws`, which means the newest version at install time. The version that was installed is in the manager's log (`gitlab-runner fleeting list`). To pin it, change `plugin = "aws"` in
`/etc/gitlab-runner/config.toml` and in the heredoc of `host/fleet-manager-install.sh` to `plugin = "aws:<major.minor.patch>"` (GitLab's plugin format), run the installer again.

## 7. Monthly cost estimate

From the AWS price list for eu-central-1: EC2 version `20261104210305` (published 2026-11-04), S3 `20261104174445`, KMS `20261026201814`, Secrets Manager `20260911124610`
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20261104210305/eu-central-1/index.json` and the same pattern for the others). The script and its full output are in
`docs/validation/VTID-05536/outputs/cost-estimate.py` and `cost-estimate.txt`. Prices are facts from that list; **everything else is an assumption, not a measurement**, and acceptance A9 replaces it with the first week's real bill.

On-Demand per hour: `m6i.xlarge` $0.23, `m6a.xlarge` $0.207, `m5.xlarge` $0.23, `m5a.xlarge` $0.208, `t3.medium` $0.048. Spot is assumed to cost **50 % of On-Demand** (AWS advertises up to 90 % savings; 50 % is
deliberately pessimistic). The blended job machine, 20 % On-Demand at the dearest type and 80 % Spot, costs $0.138 per hour. A job is assumed to take 8 minutes plus 1.5 minutes of boot.

| | Per month |
|---|---|
| **Always on**, even with no job: manager $35.04, its disk $2.86, the secret $0.40, cache storage $0.73, image snapshots $0.65, one image build $0.09 | **$39.77** |
| Light, 100 jobs a day: machines $66.46, disks $6.28, NAT data $79.08, requests $0.29 | $152 + $39.77 = **$191.89** |
| Medium, 400 jobs a day: machines $265.84, disks $25.12, NAT data $316.33, requests $1.18 | $608 + $39.77 = **$648.25** |
| Heavy, 1 200 jobs a day: machines $797.52, disks $75.37, NAT data $949.00, requests $3.53 | $1 825 + $39.77 = **$1 865.20** |

Spot at 35 % of On-Demand instead of 50 %: $178.60, $595.08 and $1 705.69. An idle fleet costs the $39.77 only. The milestone-1 machines (GitLab, the old runner, NAT gateway, load balancer) are counted in milestone 1's estimate and are not repeated here.

**The largest line is not the machines but the NAT gateway's data charge** ($0.052 per GB processed). The estimate assumes 0.5 GB per job passes through the NAT gateway (a clone of the repository through the GitLab load balancer's public address, package downloads).
That number is a guess; the cache traffic to S3 does not count because milestone 1's S3 gateway endpoint keeps it off the NAT. Each extra 0.1 GB per job costs about $63 a month at 400 jobs a day. Read the real figure in the first week (Cost Explorer, usage type `EUC1-NatGateway-Bytes`).
Levers, in this order (plan section 7): `fleet_spot_percent`, `fleet_max_instances`, `capacity_per_instance` above 1 (less isolation, so not recommended), `fleet_idle_count` above 0 (faster start, costs idle machines). The monthly budget alarm of the monitoring lane is the backstop.

## 8. What is not covered here

Image builds in CI (no privileged containers, no Docker socket: milestone 3); deploy jobs; the settings sync that creates the runner and writes the token (lane `settings`); the alarms (lane `monitoring`); the rehearsal
that proves the fleet (lane `rehearsal`, acceptance A1 and A2). If the fleet works, the first thing to look at in the rehearsal report is whether every job ran on its own machine and whether the group returned to 0 within 15 minutes.
