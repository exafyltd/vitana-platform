# Kiro AWS execution access (VTID-05764)

Plan `autonomous-to-staging` §3.5, amended by plan `autonomous-to-staging-r2` §3.2 (owner directive 2026-11-12: "Do
not request production credentials, reuse the production role or weaken IAM restrictions. Stop only at the actual
owner-controlled credential handoff").

**Status:** templates, tests and the validation/drift workflow are in this repository. **Nothing is applied.** No role,
user or key exists until the owner runs the handoff below. No workflow applies IAM, and no workflow uses
`AWS_PROD_ROLE_ARN` for this.

## 1. What Kiro gets
| Role | Account | Can | Cannot |
|---|---|---|---|
| `kiro-staging-operator` | `472838866351` (product, also the Organizations management account) | read everything except secret values (`Describe*`, `List*`, logs, metrics, CloudTrail lookup); `ecs:UpdateService` (scale, force a new deployment, or select an existing staging task-definition revision) on the 7 staging services; modify, snapshot, start/stop the `vitana-aurora-staging` cluster and run Data API statements on it; write `vitana/{gateway,supabase,erp-bridge}/staging/*` and `vitana/aurora/staging-db/*` secrets; use KMS keys tagged `vitana-env=staging` | `iam:PassRole` and task-definition registration (staging and production share the gateway task role `vitana-ecs-task-role`, `AWS-PROD-DEPLOY-GATEWAY.yml:819-822`, so no role is passable until dedicated staging roles exist); pointing a staging service at a `*-awsdr` / `*-prod` task definition; any write to a `*-awsdr` / `*-prod` ECS service, `vitana-aurora-prod`, RDS proxies, `vitana-alb-prod`, `vitana/aurora/prod/*`, `vitana/supabase/prod/*`, `vitana/gateway-awsdr/*` and `vitana/kiro/production/*` secrets, the production KMS key (explicit Deny in the role **and** in its permissions boundary); delete any cluster, instance, snapshot, service or secret; change IAM (including itself); stop CloudTrail |
| `kiro-engineering-admin` | `841276716213` (engineering platform: GitLab EE, runners, backups, CI cache) | `AdministratorAccess` | any IAM write, `iam:PassRole` or role chaining (`sts:AssumeRole`), so no escalation path to a role without these denies; terminate, re-root, detach, change tags of, SSM into or SSH into the GitLab host (`Name=vitana-eng-gitlab*`); delete any EBS volume or snapshot in the account (the GitLab root volume and snapshots are untagged); disable, delete or re-policy any KMS key (`alias/vitana-engineering` encrypts the GitLab volume, backups and secrets); delete or re-policy the backup bucket `vitana-engineering-gitlab-backups-841276716213`; read or change the GitLab root password, any runner token (`*runner-token`, incl. the fleet class tokens), the GitHub mirror and bridge tokens; stop CloudTrail; Organizations |

Both roles are assumable only by IAM user `kiro-agent-source` (`841276716213`), only with the ExternalId, and only
with a session tag `kiro-session=kiro-…` (the Kiro session id), so every action in CloudTrail names the session.
The user itself can do nothing but assume those two roles. Sessions last at most one hour.

A separate staging data account remains the stronger boundary than an allow-list in the management account; it is
recorded as a strategy decision with target date 2026-12-31 (out of scope here).

## 2. Account inventory (`841276716213`)
From repository evidence (no AWS access from Kiro yet): GitLab EE host `vitana-eng-gitlab` behind ELB
`vitana-eng-gitlab` (`gitlab.vitanaland.com`), runner fleet (`vitana-eng-runner`, `vitana-eng-fleet-manager`,
`vitana-eng-fleet-job`), VPC `vitana-eng` with public/private subnets and NAT `vitana-eng-nat`, buckets
`vitana-engineering-gitlab-backups-<account>` and `vitana-engineering-ci-cache-<account>`, secrets under
`vitana/engineering/gitlab/` (`infra/gitlab-engineering/terraform/main.tf:76`, `fleet.tf:47`). No Vitana customer
service runs there. The live, read-only inventory is the first action after the handoff
(`aws resourcegroupstaggingapi get-resources` as `kiro-engineering-admin`), appended here by a follow-up commit.

## 3. Credential handoff (owner, exact steps)
Run with an administrator identity of each account, region `eu-central-1`, from a checkout of `main`:
```bash
# 1. Engineering account 841276716213: the source user, then the admin role
aws cloudformation deploy --region eu-central-1 --stack-name kiro-agent-source \
  --template-file infra/kiro-access/source-principal.json --capabilities CAPABILITY_NAMED_IAM
EXT=$(openssl rand -hex 32)          # keep it; it goes to the Kiro secret store in step 5, nowhere else
aws cloudformation deploy --region eu-central-1 --stack-name kiro-engineering-admin \
  --template-file infra/kiro-access/engineering-admin.json --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ExternalId="$EXT"

# 2. Product account 472838866351: the operator role, its boundary and the read-only drift role
aws cloudformation deploy --region eu-central-1 --stack-name kiro-staging-operator \
  --template-file infra/kiro-access/staging-operator.json --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ExternalId="$EXT"

# 3. Engineering account: one access key for the source user (the only static credential)
aws iam create-access-key --user-name kiro-agent-source
```
5. Put `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (step 3) and `KIRO_AWS_EXTERNAL_ID` (`$EXT`) into the Kiro
   environment's secret store. Never in chat, git, a PR, an issue or a log.
6. Set repository variable `AWS_KIRO_ACCESS_DRIFT_ROLE_ARN` on `exafyltd/vitana-platform` to the stack output
   `DriftReadRoleArn` (enables the daily drift job).
7. Rotation: replace the key every 90 days (`create-access-key`, update the secret store, `delete-access-key` on the
   old one). Revocation at any time: `aws iam update-access-key --user-name kiro-agent-source --access-key-id <id>
   --status Inactive`.

**Prerequisite for staging redeploys by Kiro (owner, later):** dedicated staging task and execution roles that no
production service uses. Until then Kiro can only scale or force-redeploy existing staging revisions; new task-definition
revisions keep coming from the staging deploy workflows.

## 4. How a Kiro session uses it
```bash
aws sts assume-role --role-arn arn:aws:iam::472838866351:role/kiro-staging-operator \
  --role-session-name "$KIRO_SESSION_ID" --external-id "$KIRO_AWS_EXTERNAL_ID" \
  --tags Key=kiro-session,Value="$KIRO_SESSION_ID" --duration-seconds 3600
```
Until lane `rules-platform` lands, `collaboration.md` §7a still forbids a session tool from writing a live system: the
roles are then used read-only from sessions, and staging writes go through the staging workflows.

## 5. Checks
- `infra/kiro-access/policy.test.mjs`: every production resource denied explicitly in the role and the boundary;
  staging writes only on the pinned ARNs; reads without secret values; the boundary blocks IAM changes; trust needs the
  ExternalId and the session tag; the admin role's GitLab and credential denies; the source user can only assume the
  two roles; static drift; no static credential in the directory.
- `infra/kiro-access/drift.test.mjs` + `drift.mjs`: live inventory vs the allow-list and deny list.
- Limits of the static evaluator (`lib.mjs`): it checks one direct request at a time; it does not model escalation
  paths (PassRole, role chaining, KMS key loss, SSM on a host) or tags an attacker could change. Those paths are closed by
  explicit denies, each checked by its own test.
- `.github/workflows/AWS-KIRO-ACCESS.yml`: unit tests and `cfn-lint` on every PR that changes these files and on
  every push to `main`; the live drift check daily once the stacks exist (read-only role).
