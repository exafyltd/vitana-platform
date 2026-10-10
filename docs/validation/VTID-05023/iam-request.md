# VTID-05023 — IAM needed before the cutover window

This session's IAM user cannot read role policies. Its boundary denies
`iam:Get*`/`iam:List*` on roles. So this request covers everything the cutover
workflows call, and a read-only script shows which parts the roles already
have.

## 1. Check first (read-only, CloudShell, admin)

```bash
bash scripts/aws/iam/vtid-05023-iam-check.sh <deploy-role-name>   # role behind the AWS_PROD_ROLE_ARN repo secret
```

It runs only `iam:SimulatePrincipalPolicy` and prints the missing action/resource
pairs for both roles.

## 2. Attach (only what the check says is missing)

| Role | Policy file | What it is for |
|---|---|---|
| GitHub OIDC prod deploy role (`AWS_PROD_ROLE_ARN`) | `scripts/aws/iam/vtid-05023-deploy-role-policy.json` (inline, 6.8 KB of 10 KB) | See the statement list below |
| `vitana-ecs-task-execution-role` | `scripts/aws/iam/vtid-05023-task-execution-role-policy.json` | Tasks start with the new secrets: proxy JWT and authenticator URI, the 4 Realtime secrets, `url-aurora-proxy` (prod + staging), Aurora `database-url`, and the rehearsal authenticator URI |

To attach a file:

```bash
aws iam put-role-policy --role-name <role> --policy-name vtid-05023-cutover --policy-document file://scripts/aws/iam/<file>.json
```

### What each deploy-role statement serves

- **`EcsServicesAndTaskDefs`, `PassEcsRoles`, `CloudMap`, `Autoscaling`, `AutoscalingServiceLinkedRole`, `Logs`, `EcrNewRepos`, `EcrAuth`**: creating the new prod services. These are `vitana-postgrest-aurora-proxy-prod` (Cloud Map `postgrest-aurora-prod`, autoscaling 2–6) and the Realtime service. Used by `AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml` and `AWS-PROD-DEPLOY-REALTIME-AURORA.yml`.
- **`AlbTargetGroupsAndRules`**: the `data.vitanaland.com` (priority 8) and `realtime.vitanaland.com` (priority 9) host rules and target groups.
- **`SecretsDescribe`, `SecretsReadForVerification`**: the workflows' preflight checks. They also cover post-deploy checks with the public anon key.
- **`RealtimeSecretsCreate`, `RandomPassword`**: the Realtime workflow's `phase=secrets`, which creates its 4 secrets once.
- **`Ec2Read`, `RdsRead`**: preflight checks: security groups, and the cluster's `rds.logical_replication`.
- **`DataApiMigrations`, `DataApiMasterSecret`**: `RUN-MIGRATION.yml` and `MIGRATION-DRIFT-CHECK.yml` with `MIGRATION_TARGET=aurora` (part 8). This gives CI the Aurora **master** credentials, scoped by tag to the prod cluster and the rehearsal clone.
  - **Owner decision:** accept this, or ask for a follow-up that creates a dedicated `vitana_migrator` role and secret. The runner would then use that instead; the follow-up is not built.
- **`RehearsalCloneOnly`, `RehearsalRestoreSource`, `RehearsalKms`**: `AWS-REHEARSAL-AURORA-CLONE.yml` (part 10).
  - Every change is scoped to `vitana-aurora-rehearsal*`.
  - Production appears only as the restore source and the parameter-group copy source.
  - The script refuses any other target, and its guard test proves it.
- **`ScheduledEdgeCalls`, `EventsConnectionSecret`, `ScheduledEdgeCallsRoles`**: `AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml` (part 6, cron jobs 1 and 4). It creates the bus, the connection, the API destinations, the rules, the schedules (disabled) and their two roles.
- **`ParityReportRead`**: the edge workflow reads the part-0 parity report. **Replace `REPLACE_WITH_PARITY_REPORT_BUCKET`** with the bucket you upload the report to.
- **`SimulateExecRole`**: the proxy workflow's preflight check of the execution role.

## 3. Not IAM, but needed before the window

- **Security group:** `sg-0fbcf7b59b1f0d685` (the proxy and Realtime services) must allow TCP 4000 from the ALB's security group, for Realtime. The Realtime workflow prints the exact `authorize-security-group-ingress` command and stops until the rule exists.
- **Cloudflare:** a token with DNS edit and WAF edit on `vitanaland.com`, stored as the repo secret the edge workflow names. It covers `data.` and `realtime.` CNAMEs and the WAF/bot skip rule.
- **Repo variables**, set at the window, not before:
  - `MIGRATION_TARGET`
  - `MIGRATION_FREEZE`
  - `DATA_REST_URL`
  - `SUPABASE_URL_AURORA_PROXY_PROD_ARN` and `_STAGING_ARN`. The deploy role cannot describe secrets, so part 9 reads the new secret's ARN from these.
- **Steps run in CloudShell as admin, not by the deploy role:**
  - `aurora-cluster-params-cutover.sh --apply` and the reboot it prints.
  - `aurora-to-supabase-cdc.sh --apply` (DMS).
  - The `supabase-cutover-*.sql` files.
  - `aurora-run-sql.sh` for the Aurora SQL files.
