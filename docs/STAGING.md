# Vitana Staging Environment (AWS)

> **Process note (VTID-04610):** what happens *after* a staging deploy — the automatic STAGING-VERIFY test run, the
> ready-for-production message and PUBLISH — is defined in [`DEPLOYMENT-PIPELINE.md`](DEPLOYMENT-PIPELINE.md). This
> file describes the staging stack itself and its data plane.

Rewritten for AWS by VTID-05782 (plan `autonomous-to-staging-r2`, lane `staging-db-provision`; decision record
`.kiro/specs/autonomous-to-staging-r2/design.md`). The GCP-era staging (Cloud Run `gateway-staging`, the Supabase
`Staging` branch, `STAGE-DEPLOY.yml`, the Cloudflare preview Worker) is decommissioned with GCP (CLAUDE.md banner);
§9 keeps one line on it for old links.

Everything runs in AWS account `472838866351`, region `eu-central-1` (CLAUDE.md ALWAYS 11). Staging and production
share the ECS cluster `Vitana-ECS-Cluster`, the VPC and its private subnets; they differ by service, task definition,
host name and — after the cutover of §3 — database.

---

## 0. URLs

|                          | Production                         | Staging                                    |
|--------------------------|------------------------------------|--------------------------------------------|
| Frontend (community app) | `https://vitanaland.com`           | `https://preview-aws.vitanaland.com`       |
| Backend gateway          | `https://gateway.vitanaland.com`   | `https://preview-aws-gateway.vitanaland.com` |
| Command Hub (operator)   | `gateway.vitanaland.com/command-hub` | `preview-aws-gateway.vitanaland.com/command-hub` |
| Isolated rehearsal host (after stage 3, `staging-cutover`) | — | `https://preview-iso-gateway.vitanaland.com` (candidate services, desired count 0 outside a rehearsal) |

Service names, ALB rules and the full topology: `.claude/rules/infrastructure.md` §1b. Resolve live state with
`aws ecs describe-services` / `aws elbv2 describe-target-groups`, never from this table (CLAUDE.md ALWAYS 12).

---

## 1. Deploys

- A merge to `main` deploys to **staging only** (`AWS-STAGE-DEPLOY-GATEWAY.yml` → ECS service `vitana-gateway`;
  `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml` → `vitana-postgrest-aurora-proxy`; the community app from
  `exafyltd/vitana-v1`). Each deploy workflow's `cutover_gate` job keeps it away from production.
- STAGING-VERIFY then runs the service smoke suite plus the change's `docs/validation/<VTID>/staging-tests.json`
  against the deployed commit (read-only, CLAUDE.md rules 46–48).
- Production is reached only through PUBLISH (Command Hub) or an owner-commanded, pinned
  `AWS-PROD-DEPLOY-*.yml` dispatch (CLAUDE.md rules 49–50a, IF–THEN 21–26). Nothing in this file deploys to
  production.

---

## 2. The data plane today: shared with production

Until the cutover of §3 runs, staging **reads and writes the production data plane** (design.md §1):

| Component | Uses today | Where |
|---|---|---|
| Staging gateway `vitana-gateway` | production Supabase JWT secret, anon and service-role keys; production Aurora `database-url` and `postgrest-authenticator-uri` | `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` (task-definition secrets step) |
| Staging PostgREST proxy `vitana-postgrest-aurora-proxy` | the production Aurora PostgREST authenticator secret and writer host | `.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`, `scripts/aws/setup-postgrest-aurora-proxy-staging.sh` |
| Staging sign-in | production Supabase GoTrue | `services/gateway/src/routes/dev-auth.ts` |
| Governance writes routed through staging | PLAN-SPAR and VTID-ALLOCATE call the staging gateway by default, so they write the production ledger | `.github/workflows/PLAN-SPAR.yml`, `.github/workflows/VTID-ALLOCATE.yml` |
| STAGING-VERIFY result records | production OASIS (governance record, stays) | `.github/workflows/STAGING-VERIFY.yml` |

Consequences (they hold until the flip):
- **Every write on staging is a production write.** The test-account rules (CLAUDE.md IF–THEN 31, 31b, 32) apply on
  staging exactly as on production. Staging tests are read-only.
- `scripts/ci/staging-prod-ref-guard.mjs --report` lists every production identifier in the staging workflows and
  scripts (35 today, all in the shared-plane files above). It is report-only until the flip; afterwards it moves to
  `--enforce` in the staging deploy workflows (plan §3.4).

---

## 3. The isolated staging data plane (plan autonomous-to-staging-r2)

Three stages, each reversible, each waiting for an owner action before it costs money or changes a running service
(owner directive 2026-11-12: *"approval to revise and validate the plan, not approval to incur infrastructure costs or
execute the database provisioning and cutover"*).

| Stage | Lane | In the repository | Waits for the owner |
|---|---|---|---|
| 1 AWS access | `kiro-aws-access` (VTID-05764) + `infra/staging-db/stack.yaml` | IAM as code, tests, cfn-lint | applying the stacks (§3.3 step 2) |
| 2 Provision + seed | `staging-db-provision` (VTID-05782) | stack, provision and load scripts, schema bundle, guard, workflows | cost approval + stack (§3.3 steps 1–2) |
| 3 Cutover | `staging-cutover` | `STAGING_DATA_PLANE` switch, rehearsal, flip with automatic rollback | `STAGING_CUTOVER_APPROVED`, governance endpoint (§3.3 steps 4–5) |

### 3.1 What stage 2 adds (VTID-05782)

| Piece | What it does |
|---|---|
| `infra/staging-db/stack.yaml` | **Owner-applied** CloudFormation (never applied by CI): KMS key `alias/vitana-staging-db` (rotated, retained); DB subnet group `vitana-aurora-staging` on the two existing private subnets; security group `vitana-aurora-staging-sg` admitting 5432 **only** from `vitana-aurora-staging-client-sg`, a new group attached only to staging tasks (the shared app-tier group is also used by production tasks, so it is not admitted); placeholder secrets `vitana/aurora/staging-db/{database-url,postgrest-authenticator-uri}`; OIDC role `vitana-gha-staging-db` (trust: this repository, `main` only) with permissions boundary `vitana-staging-boundary` (design.md §4: staging cluster lifecycle and Data API only, explicit denies on every production cluster and secret, on all deletes and on IAM); a 60 USD monthly budget on tag `vitana-env=staging` (alerts at 80 % actual and 100 % forecast); optional candidate services `vitana-gateway-iso` / `vitana-postgrest-aurora-staging-iso` at desired count 0, created only when stage 3 passes `-iso` task definitions. The cluster itself is **not** in the stack. |
| `scripts/aws/staging-db-provision.sh` | `--plan` (no AWS call) / `--apply`: creates `vitana-aurora-staging` — Aurora PostgreSQL 16.4 Serverless v2, one `db.serverless` writer, the stack's key, subnet group and security group, RDS-managed master password, Data API on, backup retention 1 day, deletion protection on, tags `vitana-env=staging`. Refuses any other cluster name (and any name containing `prod`) before any AWS call; refuses `--apply` without `STAGING_DB_COST_APPROVED=yes`; capacity from the stack outputs. |
| `scripts/ci/staging-db/build-schema.mjs` | CI, no AWS: replays `supabase/migrations` on PGlite with the local stack (`scripts/mt/stack/stack.mjs`, `replay-skip.json`, the required-table gate), loads the synthetic fixtures and `infra/staging-db/seed/*.sql` (the documented test account `a27552a3-…3701` in a synthetic tenant; production call-outs neutralized), writes `bundle.sql` + `manifest.json` with a schema hash (`infra/staging-db/schema-hash.sql`). Fails on a missing required table, a missing smoke object (`vtid_ledger`, `oasis_events`, `allocate_global_vtid`), a function body/default/view that still names production, or an unreviewed production identifier in the bundle (`infra/staging-db/bundle-prod-ref-allow.json`). |
| `scripts/aws/staging-db-load.sh` | Loads the bundle through the RDS Data API (statement splitter `scripts/aws/aurora_sql_split.py`; one transaction per part), only into an empty, `vitana-env=staging`-tagged cluster, then compares the cluster's schema hash with the bundle's; mismatch → exit 1. `--dry-run` (no AWS call) and `--verify-only` (no change). |
| `scripts/ci/staging-prod-ref-guard.mjs` | Production-identifier guard (`--report` default, `--enforce`). |
| `.github/workflows/STAGING-DB-SCHEMA.yml` | Push to `main` (and this plan's lane branches) when migrations or these files change, plus dispatch: tests with PGlite, guard report, bundle build + verify, artifact `staging-db-bundle-<sha>`. No AWS. |
| `.github/workflows/AWS-STAGE-PROVISION-DB.yml` | Dispatch only, `mode: plan|apply|load`. `plan` makes no AWS call. `apply`/`load` refuse unless `vars.STAGING_DB_COST_APPROVED == 'yes'`, `vars.AWS_STAGING_DB_ROLE_ARN` is the stack role, and the run is on `main`; the guard runs in `--enforce` mode over the workflow's own inputs before the credentials step; the only role assumed is `vars.AWS_STAGING_DB_ROLE_ARN`. |

No production data is ever copied: no restore from a production snapshot, no `rehearsal-clone.sh`, no dump.

What the bundle holds today: the migrations PGlite can replay (426 of 734 at the lane's base; the rest are listed in
`supabase/tests/local-stack/replay-skip.json`; 184 of the 308 fail on a relation that does not exist
on a fresh replay, the rest on missing columns/types, Supabase-only `auth` functions and extensions PGlite does not
bundle), so the isolated database is a **subset** of the production schema. The read-only drift report of design.md
§5.4 (the existing `vars.AWS_DRIFT_ROLE_ARN`) lists the gap after the first load; it is evidence, not a gate.

### 3.2 Cost (design.md §2; AWS list prices eu-central-1, read 2026-11-12, USD before tax)

Unit prices: Serverless v2 0.14 per ACU-hour; storage 0.119 per GB-month; I/O 0.22 per million requests; Data API
0.42 per million requests; KMS key 1 per month; Secrets Manager 0.40 per secret per month.

| Option | Configuration | Compute per month | Estimated total per month |
|---|---|---|---|
| **A (recommended, stack default)** | Serverless v2 PG 16, min 0 ACU, auto-pause after 300 s, max 2 ACU | 45–240 ACU-h ≈ 6.30–33.60 | **≈ 10–45** |
| B | min 0.5 ACU (never pauses), max 2 ACU | 51.10 | ≈ 56–62 |
| Ceiling (A or B) | 2 ACU all month | 204.40 | ≈ 210 (hard cap: `MaxAcu` ≤ 2) |
| C (not recommended) | RDS PostgreSQL db.t4g.micro | 13.87 | ≈ 19–22 (not Aurora, no Data API) |
| D (not recommended) | Serverless v2 I/O-Optimized, min 0.5 | 69.35 | ≈ 73–76 |

One-time: stack and cluster creation are free; the first load ≈ 0.28 (about an hour at up to 2 ACU); each cutover
rehearsal < 1 (estimate). **Initial total < 5.** Fixed items in every option: KMS 1.00, four secrets 1.60. Risk of A:
the first request after a pause waits for the resume (typically about 15 s, measured in the rehearsal); fallback is B
(re-apply the stack with `MinAcu=0.5`, then `ModifyDBCluster`).

### 3.3 Owner runbook (the only manual steps)

1. **Cost approval.** Choose A (default) or B, then set the repository variable on `exafyltd/vitana-platform`:
   `STAGING_DB_COST_APPROVED=yes`. Without it `AWS-STAGE-PROVISION-DB.yml` refuses `apply` and `load`.
2. **Apply the stack once**, with an administrator identity of account `472838866351` (no CI role can apply IAM):
   ```bash
   aws cloudformation deploy --region eu-central-1 --stack-name vitana-staging-db \
     --template-file infra/staging-db/stack.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides MinAcu=0 MaxAcu=2 BudgetAlertEmail=<owner e-mail>
   ```
   (`MinAcu=0.5` for option B.) Then set the repository variable `AWS_STAGING_DB_ROLE_ARN` to the stack output
   `StagingDbRoleArn` (`arn:aws:iam::472838866351:role/vitana-gha-staging-db`). The budget filters on the cost
   allocation tag `vitana-env`; activate it once under Billing → Cost allocation tags if it is not active yet.
3. **Provision and seed** (any session or the owner): dispatch `AWS-STAGE-PROVISION-DB.yml` on `main` with
   `mode=plan` (review), then `mode=apply`, then `mode=load`. The load ends with "Schema hash matches the bundle".
4. **Cutover approval** (stage 3, after a passing rehearsal): `STAGING_CUTOVER_APPROVED=yes`.
5. **Governance endpoint** (before the flip): set `PLAN_SPAR_GATEWAY_URL` to the production gateway so PLAN-SPAR and
   VTID-ALLOCATE keep writing the one ledger.

Undo for stages 1–2 (nothing serving uses the isolated plane before the flip): disable deletion protection and delete
the cluster and its writer (owner action — the role cannot delete), then `aws cloudformation delete-stack
--stack-name vitana-staging-db` (the KMS key and the two secrets are retained by design; schedule their deletion
separately), and unset the two variables.

### 3.4 Authentication during and after the cutover (design.md §3)

Unchanged issuer in both modes: staging keeps validating production Supabase GoTrue tokens and the test account signs
in read-only as today. The isolated seed holds the test account's UUID, so `auth.uid()` and RLS resolve against
synthetic rows; a real member signing in on staging sees an empty, synthetic Vitana. A staging-only issuer (Cognito,
`infra/cognito-migration/README.md`) is a later plan.

### 3.5 Rollback and impact (design.md §8, §9)

Stages 1–2 and the rehearsal change no serving service. The flip records the PRIMARY task-definition revisions of
`vitana-gateway` and `vitana-postgrest-aurora-proxy`, deploys the isolated revisions, runs STAGING-VERIFY and on any
failure returns both services to the recorded revisions in the same job. Manual rollback at any time:
`STAGING_DATA_PLANE=shared` and dispatch both staging deploy workflows. Rows written to the isolated database stay
there; it holds synthetic data only.

---

## 4. Migration / publish decoupling

Schema migrations are independent of a gateway deploy or PUBLISH: `RUN-MIGRATION.yml` applies a migration (owner
approval of the file and the target database first, `.claude/rules/collaboration.md` §7d); PUBLISH moves the gateway
image. Use additive migrations (expand/contract): the code on staging and production must work against the schema
before and after the migration. After stage 2, `staging-migrations-auto` applies new migrations to
`vitana-aurora-staging` only (its `target: staging` resolves to that cluster and `vars.AWS_STAGING_DB_ROLE_ARN`).

## 5. Feature flags

`services/gateway/src/services/feature-flags.ts`: `isFeatureLive('NAME')` reads `FEATURE_<NAME>_ENV` with values
`off | staging-only | staging+prod` (unset = `off`). The same image ships to both environments; the task-definition
environment decides. Graduation: `off → staging-only → staging+prod`; rollback = flip the variable and redeploy the
task definition (same image).

## 8. Diagnostic endpoints

Auth-free, no secrets, environment identity only:
- `GET /api/v1/admin/health` → `{ ok, env: 'production'|'staging', … }`
- `GET /api/v1/admin/build-info` → `{ ok, env, git_commit, … }` — the commit staging serves (PUBLISH reads it).

## 9. Retired: GCP-era staging

Cloud Run `gateway-staging`, the Supabase `Staging` branch and its migration gap record (old §9b), `STAGE-DEPLOY.yml`
and the Cloudflare preview-router Worker belonged to the GCP stack, decommissioned 2026-08-16 (VTID-03599/VTID-03649).
The last GCP-era version of this file is in git history (`git log -- docs/STAGING.md`).

## 10. Pointer index

- Pipeline after a staging deploy: `docs/DEPLOYMENT-PIPELINE.md`
- AWS topology and deploy workflows: `.claude/rules/infrastructure.md`
- Isolated staging decision record: `.kiro/specs/autonomous-to-staging-r2/design.md`
- Kiro AWS access (stage 1): `docs/KIRO-AWS-ACCESS.md`
- Staging database evidence: `docs/validation/VTID-05782/`
