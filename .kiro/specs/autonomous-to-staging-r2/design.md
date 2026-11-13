# Design and decision record — isolated staging database (plan autonomous-to-staging-r2)

Status: proposal for owner decision. Nothing here is provisioned. Prices are AWS list prices for `eu-central-1`, read
from the AWS Price List API (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonRDS,awskms,AWSSecretsManager}/
current/eu-central-1/index.json`) on 2026-11-12, in USD, before tax and without credits. Usage figures are estimates
and are labelled as such.

## 1. Today (shared data plane), at vitana-platform `f0f88de2b5`
| Component | Uses today | Where |
|---|---|---|
| Staging gateway (`vitana-gateway`, `Vitana-ECS-Cluster`) | production Supabase JWT secret, anon key, service-role key; production Aurora `database-url` and `postgrest-authenticator-uri` | `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1113-1122`; `scripts/aws/taskdef-data-backend.py:17-23,68-72` |
| Staging PostgREST proxy (`vitana-postgrest-aurora-proxy`) | `vitana/aurora/prod/postgrest-authenticator-uri`, production Aurora writer host | `.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml:116,139`; `scripts/aws/setup-postgrest-aurora-proxy-staging.sh:97,107-108` |
| Staging sign-in | production Supabase GoTrue (`inmkhvwdcuyhnxkgfvsb`) | `services/gateway/src/routes/dev-auth.ts:142-175` |
| Governance writes routed through staging | PLAN-SPAR sparring sessions and VTID allocation call `preview-aws-gateway` by default, so they write the production ledger through the shared plane | `.github/workflows/PLAN-SPAR.yml:92`; `.github/workflows/VTID-ALLOCATE.yml:36,58` |
| STAGING-VERIFY result records | production Supabase OASIS via repo secrets | `.github/workflows/STAGING-VERIFY.yml:204-210` |
| Staging deploy role | may describe the production secrets above; no `rds:Create*` | `scripts/aws/iam/eng-platform-oidc-staging-deploy-policy.json:90-104` |

No IaC exists for `vitana-aurora-prod`; its engine version and capacity are only readable live
(`scripts/aws/rehearsal-clone.sh:174-185` shows the reads).

## 2. Cost of `vitana-aurora-staging`
Unit prices (list, eu-central-1): Aurora PostgreSQL Serverless v2 **$0.14 per ACU-hour**; I/O-Optimized $0.19 per
ACU-hour; storage **$0.119 per GB-month** (I/O-Optimized $0.268); I/O **$0.22 per million requests**; backup beyond
the free allocation $0.023 per GB-month; Data API $0.42 per million requests; RDS Proxy on Serverless v2 $0.018 per
ACU-hour; KMS customer key **$1 per month**; Secrets Manager **$0.40 per secret per month**. RDS PostgreSQL
db.t4g.micro Single-AZ $0.019 per hour, gp3 storage $0.137 per GB-month (for alternative C).

Assumptions (estimates): schema plus synthetic seed under 2 GB; 5–30 million I/O per month; 4 secrets; one KMS key;
traffic inside the existing VPC (no NAT, no public endpoint); backup retention 1 day (inside the free allocation);
pre-migration snapshots kept 7 days (under 10 GB).

| Option | Configuration | Compute per month | Fixed items | Estimated total per month |
|---|---|---|---|---|
| **A (recommended)** | Serverless v2, Aurora PostgreSQL 16 (≥ 16.3), **min 0 ACU with auto-pause after 300 s**, max 2 ACU, 1 writer, Standard I/O | 45–240 ACU-h ≈ **$6.30–$33.60** (est. 3–8 h a day awake) | storage $0.24, I/O $1.10–$6.60, KMS $1.00, secrets $1.60, snapshots ≤ $0.23, cross-AZ ≤ $0.20 | **≈ $10–45** |
| B (plan r1 default) | same, **min 0.5 ACU** (never pauses), max 2 ACU | floor 0.5 × 730 × $0.14 = **$51.10** | as A | **≈ $56–62** |
| Ceiling, A or B | max 2 ACU all month | 2 × 730 × $0.14 = **$204.40** | as A | **≈ $210** hard cap |
| C | RDS PostgreSQL db.t4g.micro Single-AZ, 20 GB gp3 | $13.87 | storage $2.74, KMS, secrets | ≈ $19–22 |
| D | Serverless v2 I/O-Optimized, min 0.5 | $69.35 | storage $0.54 | ≈ $73–76 |

Initial (one-time): stack and cluster creation have no charge; the first schema load (≈1 h at up to 2 ACU) ≈ $0.28;
each cutover rehearsal ≈ 30 minutes of candidate Fargate tasks plus database time, estimated under $1 (Fargate prices
were not pulled; estimate). **Initial total < $5.**

Recommendation: **A**, with `max 2 ACU` as the cost cap and an AWS Budget alarm at $60 per month on tag
`vitana-env=staging` (owner-applied with the stack). Risk of A: the first request after a pause waits for resume (AWS
states resume is automatic on the first connection; typical 15 s, to be measured in the rehearsal). If a connection
pool keeps the writer awake, A costs the same as B. If cold starts break STAGING-VERIFY, fall back to B (one parameter).
C is cheaper than B but is not Aurora (prod is Aurora PostgreSQL) and has no Data API, which every existing migration
script uses (`scripts/aws/aurora-apply-migration.sh`); not recommended. D only pays off at high I/O.

## 3. Authentication during and after cutover
- **During (shared and isolated modes): unchanged issuer.** Staging keeps validating tokens from the production
  Supabase GoTrue with the same JWT secret it holds today; the test account signs in read-only exactly as now
  (CLAUDE.md IF–THEN 31). The isolated seed creates the test account's profile and tenant rows under its real UUID
  `a27552a3-0257-4305-8ed0-351a80fd3701`, so `auth.uid()` and RLS resolve against synthetic data. No staging password,
  no new SaaS.
- **Effect:** a real member who signs in on staging sees an empty, synthetic Vitana (their rows are not in the staging
  database). That is the intended isolation.
- **After (later plan):** a staging-only issuer. The strategy's identity decision is Amazon Cognito
  (`infra/cognito-migration/README.md`, owner decision 2026-08-25 "Option B / B4"), so the recommended issuer is a
  staging Cognito user pool built from that scaffold, not a second Supabase project. Not in this plan.

## 4. IAM, exact permissions (staging only)
All in account `472838866351`, `eu-central-1`. Applied by the owner once (`infra/staging-db/stack.yaml`, §6).

**Stack resources (created by the owner's apply, not by any CI role):** KMS key `alias/vitana-staging-db` (tag
`vitana-env=staging`); DB subnet group `vitana-aurora-staging` on the two existing private subnets; security group
`vitana-aurora-staging-sg` with ingress 5432 only from the staging gateway and staging PostgREST task security groups;
secrets `vitana/aurora/staging-db/{database-url,postgrest-authenticator-uri}` (placeholders); candidate ECS services
`vitana-gateway-iso` and `vitana-postgrest-aurora-staging-iso` at desired count 0 with an ALB host rule
`preview-iso-gateway.vitanaland.com` (needed only for the rehearsal); Budget alarm.

**OIDC role `vitana-gha-staging-db`** (trust: `token.actions.githubusercontent.com`, `sub` =
`repo:exafyltd/vitana-platform:ref:refs/heads/main`, `aud` = `sts.amazonaws.com`), permissions boundary
`vitana-staging-boundary` (same statements; the role cannot change IAM):
| Sid | Actions | Resources / conditions |
|---|---|---|
| ClusterLifecycle | `rds:CreateDBCluster`, `rds:CreateDBInstance`, `rds:ModifyDBCluster`, `rds:ModifyDBInstance`, `rds:AddTagsToResource`, `rds:CreateDBClusterSnapshot`, `rds:EnableHttpEndpoint` | `arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-staging`, `…:db:vitana-aurora-staging-*`, `…:cluster-snapshot:vitana-aurora-staging-*`, `…:subgrp:vitana-aurora-staging`, `…:cluster-pg:vitana-aurora-staging-*`, `…:pg:vitana-aurora-staging-*`; condition `aws:RequestTag/vitana-env = staging` on create |
| ParamGroups | `rds:CreateDBClusterParameterGroup`, `rds:ModifyDBClusterParameterGroup`, `rds:CreateDBParameterGroup`, `rds:ModifyDBParameterGroup` | `…:cluster-pg:vitana-aurora-staging-*`, `…:pg:vitana-aurora-staging-*` |
| Read | `rds:Describe*`, `rds:ListTagsForResource`, `ec2:DescribeSubnets`, `ec2:DescribeSecurityGroups`, `ec2:DescribeVpcs` | `*` (read-only) |
| DataApi | `rds-data:ExecuteStatement`, `rds-data:BatchExecuteStatement`, `rds-data:BeginTransaction`, `rds-data:CommitTransaction`, `rds-data:RollbackTransaction` | `…:cluster:vitana-aurora-staging` |
| Secrets | `secretsmanager:GetSecretValue`, `secretsmanager:PutSecretValue`, `secretsmanager:DescribeSecret` | `…:secret:vitana/aurora/staging-db/*`; the RDS-managed master secret only with condition `aws:ResourceTag/aws:rds:primaryDBClusterArn = …:cluster:vitana-aurora-staging` |
| Kms | `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey*`, `kms:DescribeKey`, `kms:CreateGrant` | the stack key ARN; condition `kms:ViaService` in `rds.eu-central-1.amazonaws.com`, `secretsmanager.eu-central-1.amazonaws.com` |
| Slr | `iam:CreateServiceLinkedRole` | `arn:aws:iam::472838866351:role/aws-service-role/rds.amazonaws.com/*`, condition `iam:AWSServiceName = rds.amazonaws.com` |
| DenyProduction | `rds:*`, `rds-data:*` | `…:cluster:vitana-aurora-prod`, `…:db:vitana-aurora-prod*`, `…:cluster-snapshot:rds:vitana-aurora-prod*` (Deny) |
| DenyProdSecrets | `secretsmanager:*` | `…:secret:vitana/aurora/prod/*`, `…:secret:vitana/supabase/prod/*` (Deny) |
| DenyDelete | `rds:DeleteDBCluster`, `rds:DeleteDBInstance`, `rds:DeleteDBClusterSnapshot` | `*` (Deny; deletion stays an owner action) |
| DenyIam | `iam:*` except the SLR statement | `*` (Deny) |

**Cutover additions to the existing staging deploy role** (`scripts/aws/iam/eng-platform-oidc-staging-deploy-policy.json`,
owner-applied): `secretsmanager:DescribeSecret` on `…:secret:vitana/aurora/staging-db/*`; `ecs:UpdateService` on the two
candidate services. After the flip has been green for 7 days: remove the five production secret ARNs at `:97-101`.

No production credential is requested; the production role (`AWS_PROD_ROLE_ARN`) is not used by any of these workflows,
and the guard fails a staging workflow that names it.

## 5. Schema reproduction and validation
1. **Build in CI, no AWS:** `scripts/ci/staging-db/build-schema.mjs` replays `supabase/migrations/**` in timestamp order
   with the existing local-stack replay (`scripts/mt/stack/stack.mjs` `replay()`, skips in
   `supabase/tests/local-stack/replay-skip.json`, roles from `scripts/mt/stack/stub-auth.sql`), loads the synthetic
   fixtures (`supabase/tests/fixtures/*.sql`) and the staging seed, and writes one SQL bundle plus a schema hash
   (sorted `information_schema` columns, constraints, indexes, functions, policies).
2. **Fail closed:** missing any table of `supabase/tests/local-stack/required-tables.txt`, or `vtid_ledger`,
   `next_vtid`, the OASIS tasks tables the smoke reads (`scripts/ci/staging-verify/smoke/gateway.json`), fails the build.
3. **Load:** `staging-db-load.sh` applies the bundle through the Data API with the existing statement splitter and
   compares the cluster's hash with the bundle's.
4. **Drift report (read-only):** the existing drift role (`vars.AWS_DRIFT_ROLE_ARN`, read-only Data API on prod) lists
   objects present in production but absent from staging (expected: objects created outside migrations); the report is
   evidence, not a gate, until the gap list is empty or accepted.
5. **Behaviour:** the rehearsal's STAGING-VERIFY (smoke 33 checks today) runs against the candidate on the isolated
   data.
No production data is ever copied (no restore from a production snapshot, no `rehearsal-clone.sh`).

## 6. Owner actions (exact)
1. Cost approval: set repository variable `STAGING_DB_COST_APPROVED=yes` on `exafyltd/vitana-platform` (choose A or B;
   A is the default in the stack parameters).
2. Apply the stack once with an administrator identity of account `472838866351`:
   `aws cloudformation deploy --region eu-central-1 --stack-name vitana-staging-db --template-file
   infra/staging-db/stack.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides MinAcu=0 MaxAcu=2`
   then set repository variable `AWS_STAGING_DB_ROLE_ARN` to the stack output `StagingDbRoleArn`.
3. Cutover approval, after a passing rehearsal: set `STAGING_CUTOVER_APPROVED=yes`.
4. Governance endpoint, before the flip: set `PLAN_SPAR_GATEWAY_URL` (used by PLAN-SPAR and VTID-ALLOCATE) to the
   production gateway, so the one ledger stays the one ledger (§9).

## 7. Stages and what each needs
| Stage | Lane | Code and CI | Needs owner |
|---|---|---|---|
| 1 AWS access | r1 `kiro-aws-access` + `infra/staging-db/stack.yaml` | yes, now | §6.2 (credential handoff) |
| 2 Provision + seed | `staging-db-provision` | yes, now (`--plan`, CI schema build) | §6.1 + §6.2 before `apply` |
| 3 Cutover | `staging-cutover` | yes, after stage 2 merges | §6.3, §6.4 before the flip |

## 8. Rollback and recovery criteria
- **Rehearsal** changes nothing that is serving: the candidate services are scaled back to 0 at the end, pass or fail.
- **Flip:** the job records the PRIMARY task-definition ARNs of `vitana-gateway` and `vitana-postgrest-aurora-proxy`
  before changing anything. After the isolated deploy it runs STAGING-VERIFY. **Recovered** means, within 20 minutes of
  the failure: both services' PRIMARY deployment is on the recorded ARN and `rolloutState=COMPLETED`; `/alive` 200;
  `/api/v1/admin/build-info` returns `env=staging`; STAGING-VERIFY smoke passes in full on the deployed commit. If any
  of these fails, the job sets `STAGING_DATA_PLANE=shared` (the default) and re-dispatches both staging deploys, which
  rebuild today's task definitions, and opens a quarantine entry.
- **Manual rollback at any time:** set `STAGING_DATA_PLANE=shared` and dispatch `AWS-STAGE-DEPLOY-GATEWAY.yml` and
  `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`; same recovery criteria.
- **Data:** rows written to the isolated database stay there and are not merged back; it holds synthetic data only.

## 9. Impact on active sessions and STAGING-VERIFY
- **Stages 1–2 and the rehearsal:** none. The serving staging services, secrets and task definitions do not change;
  the rehearsal uses candidate services and a separate host.
- **The flip:** one staging deploy window (~10 minutes, the §8a one-staging-deploy-at-a-time rule). Merges in that
  window wait for their STAGING-VERIFY; the flip is scheduled when no lane is between merge and STAGING-VERIFY.
- **After the flip:** change suites that read real production rows fail. `staging-cutover` first classifies every
  `docs/validation/*/staging-tests.json` (437 gateway suites today) by the routes they read and lists the ones that need
  a seed row; the flip is refused while any active lane's suite is in that list without a seed.
- **Governance writes (blocking the flip until fixed):** PLAN-SPAR and VTID-ALLOCATE default to the staging gateway
  (`PLAN-SPAR.yml:92`, `VTID-ALLOCATE.yml:36`). Isolated, they would write a second ledger. Owner action §6.4 points
  them at the production gateway first; `staging-cutover` also inventories every other workflow that calls
  `preview-aws-gateway` for ledger or OASIS writes (12 workflows reference it today) and the flip is refused until each
  is classified. In isolated mode the staging gateway runs with `VTID_ALLOCATOR_ENABLED=false`.
- **STAGING-VERIFY result records** keep going to production OASIS (governance record, unchanged).

## 10. Conflicts with the strategy repository
- The strategy's identity decision (Cognito) differs from plan r1 §3.3 ("staging auth on the existing gateway JWT
  path"). This revision keeps the current issuer and names Cognito for the later staging issuer (§3).
- No other conflict found: the design adds no allocator, ledger, scheduler or orchestrator, keeps production
  unchanged, and keeps `472838866351` / `eu-central-1`.
