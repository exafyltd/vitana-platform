---
change_class: standard
---
# plan(eng-platform-p01): engineering platform phase 0+1 — program document, read-only AWS inventory, keyless staging CI

Author: Kiro, seat `exafy`, session `kiro-exafy-202611021438-cff7` (Kiro Web). Premises pinned to vitana-platform
`origin/main` `50e55fd3a4` and vitana-v1 `origin/main` `5c75715e1` (declared as `spar_refs` in `handoff.md`).

<!-- plan:begin -->
## 1. Goal
Owner, 2026-11-02: *"now you check the codebase and make your own plan based on this project definition, so that we
get your own guidance how to execute this project to build our self hosted CI/CD GitLab for Vitanaland"*; on the
open decisions: *"you decide for me"*. The program (self-hosted GitLab on AWS, ephemeral runner fleet, governed agent
delivery) is written down in `docs/ENGINEERING-PLATFORM-PLAN.md` (lane `program-doc`) with the decisions taken. This
plan is its **first slice**: Phase 0 (a read-only AWS inventory script the owner runs) and Phase 1 (remove the
long-lived AWS keys from staging and preview CI, and prepare narrowly-trusted OIDC roles). Phase 1 is needed whatever
CI system runs later: the GitLab runners in Phase 3 reuse the same trust pattern, and the gap it closes exists today.

Decisions taken for the owner (logged in `RUN/decisions.md`, restated in the program document):
D1 move source control to GitLab in stages, vitana-v1 first; D2 GitLab self-managed Premium, installed as the EE
package unlicensed (runs as Free) and licensed before the vitana-v1 cutover; D3 a new AWS engineering account for
GitLab and runners; D4 single-node Omnibus EE + RDS + ElastiCache + S3 object storage (RPO 1 h, RTO 4 h); D5 Kiro
writes Terraform and scripts, the owner applies; D6 GitLab local accounts with mandatory 2FA; D7 a non-production
database is a dependency of backend previews, not part of this program.

## 2. Today (evidence)
- **Static staging keys reach PR code.** vitana-v1 `.github/workflows/PREVIEW-DEPLOY-FRONTEND.yml:27-28` runs on
  `pull_request` and configures AWS with `secrets.AWS_STAGING_ACCESS_KEY_ID` (`:111`); `PREVIEW-TEARDOWN-FRONTEND.yml`
  the same (`:16-17`, `:60`). The same IAM user's keys deploy the **production** frontend
  (vitana-v1 `AWS-PROD-DEPLOY-FRONTEND.yml`, documented as a temporary exception in
  `.claude/rules/infrastructure.md` §1b table row "community-app"). Any branch pushed to vitana-v1 runs its own copy of
  the PR workflow, so the keys are only as protected as the least-trusted branch writer.
- **Every other static-key user** (vitana-platform): `ALERT-APP-USERS-IDENTITY-DRIFT.yml:70`,
  `AWS-PROVISION-APPILIX-SECRETS.yml:106` (staging leg), `AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml:44`,
  `AWS-STAGE-DEPLOY-ERP-BRIDGE.yml:95`, `AWS-STAGE-DEPLOY-GATEWAY.yml:205`, `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml:106`,
  `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml:92`, `I18N-DB-SEED.yml:116`; vitana-v1 `AWS-STAGE-DEPLOY-FRONTEND.yml:150`.
  This list is complete: `grep -rl AWS_STAGING_ACCESS_KEY_ID .github/` returns exactly these 8 files in vitana-platform
  (0 hits in `AWS-STAGING-VALIDATION.yml`, `AWS-OPS-ECS-SCALE-UNGOVERNED.yml`, `AWS-REHEARSAL-AURORA-CLONE.yml`), and
  in vitana-v1 the 3 files above plus `AWS-PROD-DEPLOY-FRONTEND.yml`. Lane tests find the files by this grep, not by
  a fixed list (sparring R1-F1). `ALERT-APP-USERS-IDENTITY-DRIFT.yml` reads **production** Aurora with the
  `claude-readonly` secret over the Data API (`:59-60`; its permission on the staging keys is marked unverified at
  `:34-42`), so it moves to the read-only drift role, not the staging deploy role (sparring R1-F3).
  None of these files grants `id-token: write` except `AWS-PROVISION-APPILIX-SECRETS.yml:84` (its prod leg).
  `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml:29` also triggers on `pull_request`, but its AWS job is skipped there (`:92`).
- **The documented OIDC trust is repo-wide.** `scripts/aws/README.md:49-54` scopes the role trust with
  `StringLike … "sub": "repo:exafyltd/vitana-platform:*"`, i.e. any branch, PR or dispatch ref. The live trust of
  `AWS_PROD_ROLE_ARN` is not in git (`.claude/rules/infrastructure.md` §1b points to `docs/AWS-PRODUCTION-BUILD-LOG.md`).
- **The prod role and the Aurora master secret are used from a PR trigger.** `MIGRATION-DRIFT-CHECK.yml:24-29` runs on
  `pull_request`; its aurora branch assumes `secrets.AWS_PROD_ROLE_ARN` (`:126-131`), then reads the cluster's
  **master user** secret (`MasterUserSecret.SecretArn`, `:144-145`) and queries through the RDS Data API (`:148-150`).
  A read-only DB identity already exists: `vitana/aurora/prod/claude-readonly`, described as an RDS Data API secret
  (`scripts/aws/setup-operator-sql-readonly-secret.sh:11`, read at `:49`). `pg_class`/`pg_namespace`, the only
  objects the drift query reads (`:145`), are readable by any role. Every other `AWS_PROD_ROLE_ARN` workflow is
  `workflow_dispatch` only, or `push`/`schedule` on `main` (`CODEINTEL-INDEX.yml`, `TEST-CATALOG.yml`). So narrowing the
  prod trust to `main` breaks only that one PR path, which this plan moves to a read-only role first.
- **No read-only inventory exists.** `scripts/aws/` holds 70+ setup and cutover scripts (e.g. `setup-kiro-runner.sh`,
  `verify-aws-production.sh`), none of which lists accounts, VPCs, IAM trusts, ECR, ECS and secrets in one read-only
  pass; `.claude/rules/infrastructure.md` §1b records 23 undocumented ECS services. The setup scripts state that AWS
  admin actions are run by the owner (`scripts/aws/setup-kiro-runner.sh` header).
- **Tests that read workflow or script text** already exist and are the pattern for this plan:
  `services/gateway/test/operator-agent-task-role-grants-script.test.ts` (script text),
  `services/gateway/test/vtid-05009-provision-pack-token-workflow.test.ts:19-25` (pins
  `secrets.AWS_STAGING_ACCESS_KEY_ID`, and at `:24` asserts the file has **no** `id-token: write`, to keep that
  workflow staging-only with no prod role), vitana-v1 `src/lib/supabase-functions-retire.vtid-05008.test.ts` (workflow text, Vitest).

## 3. Interfaces (fixed here, not by the lanes)
- Repository **variables** (not secrets; an ARN is not a credential): vitana-platform `AWS_STAGING_ROLE_ARN`,
  `AWS_DRIFT_ROLE_ARN`; vitana-v1 `AWS_STAGING_ROLE_ARN`, `AWS_PREVIEW_ROLE_ARN`.
- IAM roles (account `472838866351`, created only by the owner running lane `oidc-roles`' script):
  - `vitana-gha-staging-deploy`: trust `sub` exactly `repo:exafyltd/vitana-platform:ref:refs/heads/main` or
    `repo:exafyltd/vitana-v1:ref:refs/heads/main`; permissions = the effective policies of IAM user
    `claude-staging-validation` at the time the script runs: its attached managed and inline policies **and** those of
    every IAM group it belongs to (`list-groups-for-user` → `list-attached-group-policies` / `list-group-policies`).
    A permissions boundary on the user is copied as the role's boundary. Same reach as today, no new grant.
  - `vitana-gha-v1-preview`: trust `sub` exactly `repo:exafyltd/vitana-v1:pull_request`; permissions only
    `s3:PutObject/GetObject/DeleteObject/ListBucket` on `vitana-pr-previews` (`PREVIEW-DEPLOY-FRONTEND.yml:50`) and
    `cloudfront:CreateInvalidation` on the preview distribution.
  - `vitana-gha-drift-readonly` (used by `MIGRATION-DRIFT-CHECK.yml` and `ALERT-APP-USERS-IDENTITY-DRIFT.yml`): trust
    `sub` `repo:exafyltd/vitana-platform:pull_request` or `…:ref:refs/heads/main`;
    permissions only `rds:DescribeDBClusters` and `rds-data:ExecuteStatement` on cluster `vitana-aurora-prod`, and
    `secretsmanager:DescribeSecret` / `GetSecretValue` on `vitana/aurora/prod/claude-readonly-*`. It has no access to
    the master user secret.
  - Prod deploy role trust (narrowing, separate `--narrow-prod-trust` step): `sub` exactly
    `repo:exafyltd/vitana-platform:ref:refs/heads/main`. All trusts use `StringEquals` and `aud` `sts.amazonaws.com`.
- Workflow credential step shape (lanes `stage-oidc-platform`, `stage-oidc-v1`): `role-to-assume: ${{ vars.<ROLE VAR> }}`,
  `aws-access-key-id: ${{ !vars.<ROLE VAR> && secrets.AWS_STAGING_ACCESS_KEY_ID || '' }}` (secret likewise), plus
  `id-token: write` in `permissions`. Variable unset → behaviour byte-for-byte as today (keys); set → OIDC only.

## 4. Lanes
### Lane `program-doc` (vitana-platform, executor kiro, seat exafy)
`paths`: `docs/ENGINEERING-PLATFORM-PLAN.md`, `docs/validation/**`. The program document: findings with `file:line`,
decisions D1-D7 with reasons, target architecture (engineering account, GitLab, four CI runner classes, cross-account
OIDC), mapping of today's gates (PLAN-SPAR, PR-GATE, land-guard, STAGING-VERIFY, Gate 2) to GitLab features, phases
0-8 with exit criteria, acceptance criteria A01-A34, what is explicitly not done, risks. Docs only.
### Lane `aws-inventory` (vitana-platform, executor kiro, seat exafy)
`paths`: `scripts/aws/inventory-readonly.sh`, `services/gateway/test/eng-platform-inventory-readonly.test.ts`,
`docs/validation/**`. A bash script the owner runs with a read-only identity: `set -euo pipefail`; refuses unless
`aws sts get-caller-identity` returns account `472838866351` (CLAUDE.md IF-THEN 11) and region `eu-central-1` unless
`--region` names another; every AWS call is a `describe-*`, `list-*` or `get-*` verb (no `get-secret-value`, no
`get-parameter --with-decryption`: secret names and metadata only); writes JSON plus a `summary.md` into a local
`--out` directory (default `./aws-inventory-<UTC date>`), never to S3 or any remote. Covers: Organizations (if
permitted), VPCs/subnets/SGs/endpoints, IAM roles with trust policies and OIDC providers, IAM users with access-key
age, attached/inline policies, group memberships (with each group's attached/inline policies) and permissions boundary, ECR repos and tag mutability, ECS clusters/services/task-def families, RDS/Aurora, ElastiCache, ALBs and
listener rules, S3 buckets (name, region, encryption, public-access block), Secrets Manager names, CloudTrail/Config/
Security Hub status, Cost Explorer last-30-days by service (if permitted). Any denied call is recorded and skipped.
### Lane `oidc-roles` (vitana-platform, executor kiro, seat exafy)
`paths`: `scripts/aws/setup-github-oidc-roles.sh`, `scripts/aws/iam/eng-platform-oidc-*.json`,
`services/gateway/test/eng-platform-oidc-roles.test.ts`, `docs/validation/**`. Trust and permission JSON for the
three roles and the narrowed prod trust of §3; a script, **dry-run by default** (prints current state and the change),
`--apply` creates or updates the three roles, `--narrow-prod-trust <role-name>` prints the live prod trust and
replaces it with the §3 one only on `--apply`. Same account/region guard as `aws-inventory`. Never creates an access
key, never deletes the IAM user (that is the owner's follow-up after OIDC runs green, §8).
### Lane `stage-oidc-platform` (vitana-platform, executor kiro, seat exafy)
`paths`: the eight vitana-platform workflows of §2 (static-key list), `.github/workflows/MIGRATION-DRIFT-CHECK.yml`,
`services/gateway/test/eng-platform-stage-oidc-workflows.test.ts`,
`services/gateway/test/vtid-05009-provision-pack-token-workflow.test.ts`, `docs/validation/**`. Each credential step takes
the §3 shape with `AWS_STAGING_ROLE_ARN`, except `ALERT-APP-USERS-IDENTITY-DRIFT.yml`, which takes it with
`AWS_DRIFT_ROLE_ARN` (production read-only data, sparring R1-F3); `id-token: write` added to each file's `permissions`. In
`AWS-PROVISION-APPILIX-SECRETS.yml` only the staging leg changes; its prod leg is untouched. `MIGRATION-DRIFT-CHECK.yml`
aurora branch: `role-to-assume: ${{ vars.AWS_DRIFT_ROLE_ARN || secrets.AWS_PROD_ROLE_ARN }}`, and when
`AWS_DRIFT_ROLE_ARN` is set the Data API `--secret-arn` is the `vitana/aurora/prod/claude-readonly` secret (resolved by
`describe-secret`) instead of the master secret; unset → both unchanged.
No `AWS-PROD-*` file is edited.
`vtid-05009-provision-pack-token-workflow.test.ts:24` (`not.toContain('id-token: write')`) guards "staging only, no
prod role" for `AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml`; OIDC needs `id-token: write`, so that one assertion is
replaced by a stricter check of the same intent: every `role-to-assume` in the file is exactly
`${{ vars.AWS_STAGING_ROLE_ARN }}` (and the existing `not.toContain('AWS_PROD_ROLE_ARN')` / `vitana/gateway/prod/`
assertions stay). No other assertion in that file changes. Sparring R1-F1.
### Lane `stage-oidc-v1` (vitana-v1, executor kiro, seat exafyltd)
`paths`: `.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml`, `.github/workflows/PREVIEW-DEPLOY-FRONTEND.yml`,
`.github/workflows/PREVIEW-TEARDOWN-FRONTEND.yml`, `src/lib/eng-platform-stage-oidc.test.ts`, `docs/validation/**`.
Stage deploy uses `AWS_STAGING_ROLE_ARN`; both preview workflows use `AWS_PREVIEW_ROLE_ARN`, same §3 shape. The
preview workflows' missing-secret check (`PREVIEW-DEPLOY-FRONTEND.yml:70`, `PREVIEW-TEARDOWN-FRONTEND.yml:45`) accepts
the role variable as an alternative to the keys. `AWS-PROD-DEPLOY-FRONTEND.yml` is not edited.

## 5. Parallelism, shared and hot files
All five lanes are independent: no file is shared, no hot file, no migration. `depends_on` is empty for every lane;
the role/variable contract of §3 is the only interface and is fixed by this plan. Every workflow lane keeps today's
behaviour until the owner sets the variables, so merge order does not matter; their merges redeploy staging (§7).

## 6. Tests (each red on base)
- `aws-inventory`: `npx jest test/eng-platform-inventory-readonly.test.ts` (in `services/gateway`) — red on base (script
  absent); green after: file exists, `set -euo pipefail`, account guard string `472838866351`, every `aws <svc> <verb>`
  token matches `^(describe|list|get)-`, and none of `get-secret-value`, `--with-decryption`, `s3 cp`, `s3 sync`,
  `put-`, `create-`, `delete-`, `update-` appears. Plus one real run: `bash scripts/aws/inventory-readonly.sh --help`
  and a run with no credentials that exits non-zero at the account guard (output in `docs/validation/<VTID>/`).
- `oidc-roles`: `npx jest test/eng-platform-oidc-roles.test.ts` — red on base; green after: every trust JSON parses,
  uses `StringEquals` only, every `sub` equals one of the §3 values (no `*`), `aud` is `sts.amazonaws.com`; the
  preview and drift permission JSON contain no `"Action": "*"` / `"Resource": "*"`; the script defaults to dry-run
  (`--apply` absent → no `create-role`/`update-assume-role-policy`/`put-role-policy` call is reached; asserted on the
  script's control flow text), never contains `create-access-key` or `delete-user`, and reads group-inherited
  policies (`list-groups-for-user`, `list-attached-group-policies`, `list-group-policies`) and the user's
  permissions boundary (sparring R1-F2).
- `stage-oidc-platform`: `npx jest test/eng-platform-stage-oidc-workflows.test.ts` — red on base; green after: in each
  of the nine files every `configure-aws-credentials` step that used the static keys carries `vars.AWS_STAGING_ROLE_ARN`
  (or `vars.AWS_DRIFT_ROLE_ARN` for drift) and the `!vars.… &&` key guard, `permissions` has `id-token: write`, the
  `AWS-PROVISION-APPILIX-SECRETS.yml` prod leg is byte-identical to base, every file still parses as YAML.
  `vtid-05009-provision-pack-token-workflow.test.ts` with its `:24` assertion replaced as in §4: red on base for the
  new check (no `role-to-assume` at all on base → the "only the staging role variable" check fails because the
  staging role variable is absent), green after; its other assertions unchanged and green.
- `stage-oidc-v1`: `npx vitest run src/lib/eng-platform-stage-oidc.test.ts` — same assertions for the three files.
- `program-doc`: no test (docs only); the reviewer checks every `file:line` it cites resolves on `origin/main`.

## 7. Staging verification
`aws-inventory`, `oidc-roles` and `program-doc` deploy nothing. The two workflow lanes **do** trigger staging deploys:
each `AWS-STAGE-DEPLOY-*` workflow lists its own file in its `push` paths (vitana-platform `AWS-STAGE-DEPLOY-GATEWAY.yml:39`,
`-ERP-BRIDGE.yml:30`, `-KIRO-RUNNER.yml:28`, `-POSTGREST-AURORA-PROXY.yml:40`; vitana-v1
`AWS-STAGE-DEPLOY-FRONTEND.yml:54`), so the merge commit redeploys those services to staging from `main` on the
**unchanged key path** (variables unset). That run is the staging proof that the fallback is byte-for-byte today's
behaviour: each deploy's own smoke gate (`/api/v1/admin/health` env=staging and build-info commit) must pass, and
STAGING-VERIFY runs on the merge commit. Only one lane's deploys run at a time (common rule 11): `stage-oidc-platform`
and `stage-oidc-v1` touch different repos and services, so they may land in either order, never in the same minute
as another staging deploy of the same service. Each lane's `docs/validation/<VTID>/staging-tests.json` holds a
read-only `existing` ref (its Jest/Vitest file). The OIDC path is verified after the owner's §8 step 2 by the next
staging deploy run, linked in `handoff.md`; until then each lane says "not verified on staging (OIDC path): role not
created yet (owner step)".

## 8. Rollout (owner steps after merge, asked once with Gate 2)
1. Run `scripts/aws/inventory-readonly.sh` with a ReadOnlyAccess identity; commit nothing secret, Kiro files the
   summary into the program document in a follow-up lane.
2. Run `scripts/aws/setup-github-oidc-roles.sh` (dry-run), then `--apply`; set the four variables of §3.
3. After one green staging deploy, one preview deploy and one drift run on OIDC: deactivate, then delete, the
   `claude-staging-validation` access keys; run `--narrow-prod-trust <AWS_PROD_ROLE_ARN role> --apply`.
4. Owner command needed for the `AWS-PROD-*` follow-ups this plan does not touch: prod frontend deploy to OIDC, and
   promotion pinned by image digest in `AWS-PROD-DEPLOY-GATEWAY.yml`.
Rollback at any point: unset the variable (workflows fall back to keys while the keys still exist); restore the prior
prod trust JSON the script printed in step 3.

## 9. Risks
- `configure-aws-credentials` with an empty `role-to-assume` and keys set must behave as today: covered because an
  empty action input is treated as unset; the first push after merge (variable unset) exercises it on staging.
- The `claude-readonly` secret is documented as a Data API secret (`setup-operator-sql-readonly-secret.sh:11`); the first
  `MIGRATION-DRIFT-CHECK` dispatch with `target=aurora` after step 2 proves it, and unsetting `AWS_DRIFT_ROLE_ARN`
  restores today's path.
- If `claude-staging-validation` holds production data-plane permissions (rds-data / `claude-readonly`), the copied
  staging role inherits them. The inventory (`aws-inventory`) lists the user's effective policies before the owner runs
  `--apply`; the program document records the result, and narrowing the staging role is a Phase 3 item.
- The staging role copies the IAM user's permissions, which may be broad: no new reach, but not narrower either;
  narrowing is a Phase 3 item informed by the inventory.
- Narrowing the prod trust can break an unknown caller: the script prints the live trust first, and the inventory lists
  every principal that assumed the role (CloudTrail `AssumeRoleWithWebIdentity` is out of scope; the owner checks).

## 10. Unchanged / out of scope
Every `AWS-PROD-*` workflow; `AWS-PROVISION-APPILIX-SECRETS.yml`'s prod leg; GitLab provisioning (next plan,
`eng-platform-gitlab-foundation`, Terraform for the engineering account); gateway `GitProvider` work (Phase 4); the
dead `EXEC-DEPLOY.yml` references in gateway code (`routes/cicd.ts`, `services/deploy-orchestrator.ts`) and
`AUTO-DEPLOY.yml`, recorded as findings in the program document; multi-tenant files; any database change.
<!-- plan:end -->
