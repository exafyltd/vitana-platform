# VTID-05782 — autonomous-to-staging-r2, lane `staging-db-provision`

Plan: `.kiro/specs/autonomous-to-staging-r2/plan.md` §3.3 (stage 2), decision record `design.md` §2, §4, §5, §6.
Owner directive 2026-11-12: *"approval to revise and validate the plan, not approval to incur infrastructure costs or
execute the database provisioning and cutover."* This lane is code and validation only: no AWS call was made, nothing
was provisioned, no migration was applied, no production credential or role was used.

## What changed
- `infra/staging-db/stack.yaml` (owner-applied CloudFormation, JSON content): KMS key `alias/vitana-staging-db`
  (rotation, retained), DB subnet group `vitana-aurora-staging`, security groups `vitana-aurora-staging-sg` (5432 only
  from) `vitana-aurora-staging-client-sg`, placeholder secrets `vitana/aurora/staging-db/{database-url,
  postgrest-authenticator-uri}`, OIDC role `vitana-gha-staging-db` (this repo, `main` only) + boundary
  `vitana-staging-boundary` with the statements of design.md §4, budget `vitana-staging-db-monthly` (60 USD, tag
  `vitana-env=staging`), optional candidate services at desired count 0 (stage 3). Capacity parameters (option A
  default) are stack outputs the provision script reads.
- `infra/staging-db/schema-hash.sql`, `infra/staging-db/seed/{010_staging_test_user,020_neutralize_production_callouts}.sql`,
  `infra/staging-db/bundle-prod-ref-allow.json`.
- `scripts/aws/staging-db-{common,provision,load}.sh`.
- `scripts/ci/staging-db/build-schema.mjs` (bundle + hash, `--verify`), `scripts/ci/staging-prod-ref-guard.mjs`.
- `.github/workflows/STAGING-DB-SCHEMA.yml`, `.github/workflows/AWS-STAGE-PROVISION-DB.yml`.
- Tests: `scripts/ci/staging-db/{stack,aws-scripts,build-schema,prod-ref-guard,workflows}.test.mjs` + fixtures
  (guard fixtures, stub AWS CLI `fixtures/bin/aws`).
- `docs/STAGING.md` rewritten for AWS (shared plane today, isolated plane, cost table, owner runbook).

## Acceptance criteria → tests

AC-1 `--plan` prints no production identifier and makes no AWS call; any cluster name outside `vitana-aurora-staging*`, and the production cluster, is refused before any AWS call.
TEST: scripts/ci/staging-db/aws-scripts.test.mjs ("provision --plan makes no AWS call and prints no production identifier"; "provision --plan option B: min 0.5 ACU, no auto-pause")
TEST: scripts/ci/staging-db/aws-scripts.test.mjs ("provision refuses cluster \"vitana-aurora-prod\" before any AWS call (plan and apply)"; the same for "vitana-aurora-staging-prod", "vitana-aurora", "my-db", "vitana-aurora-stagingx", "VITANA-AURORA-STAGING", "vitana-aurora-staging;rm")
TEST: scripts/ci/staging-db/aws-scripts.test.mjs ("load refuses a non-staging cluster and a tampered bundle before any AWS call")

AC-2 The guard fails on each production-identifier fixture under `--enforce` (config, workflow YAML, task-definition JSON, cluster script, `*-awsdr` service, Supabase secret, KMS key); report mode exits 0; a Deny-only CloudFormation statement is not a finding.
TEST: scripts/ci/staging-db/prod-ref-guard.test.mjs ("--enforce fails on the config.json fixture (supabase-project-ref)"; "--enforce fails on the workflow.yml fixture (prod-role-secret)"; "--enforce fails on the taskdef.json fixture (aurora-prod-secret)"; "--enforce fails on the cluster.sh fixture (aurora-cluster)"; "--enforce fails on the awsdr-service.sh fixture (awsdr-service)"; "--enforce fails on the supabase-secret.yml fixture (supabase-prod-secret-prefix)"; "--enforce fails on the kms-allow.json fixture (kms-key)")
TEST: scripts/ci/staging-db/prod-ref-guard.test.mjs ("--report lists the same findings and exits 0 (default mode)"; "CloudFormation: an identifier inside an Effect=Deny statement is not a finding; the same outside is"; "guard lists every production identifier of plan §3.3 and the gate invariant")
TEST: scripts/ci/staging-db/prod-ref-guard.test.mjs ("the isolated staging plane of this lane has no production reference (--enforce over its own files)")

AC-3 `build-schema.mjs` succeeds on `main` (schema hash and bundle size in evidence) and fails when a required table is removed from the replay (fixture skip list), when a smoke object is missing, or when a production call-out survives the seed.
TEST: scripts/ci/staging-db/build-schema.test.mjs ("build-schema succeeds on this checkout: hash, bundle, smoke objects, seed, no live production reference")
TEST: scripts/ci/staging-db/build-schema.test.mjs ("build-schema fails when a required table is removed from the replay (fixture skip list)"; "build-schema fails when the creator of the VTID ledger is skipped (smoke object missing)"; "build-schema fails when a production call-out is not neutralized by the seed (live check)")
TEST: scripts/ci/staging-db/build-schema.test.mjs ("missingSmokeObjects names every object that is not there"; "production references in the bundle must be in the allow list, with the exact count; stale entries fail"; "verifyBundle refuses a tampered bundle, a missing manifest and a wrong schema")
Evidence: schema hash `d9118a134c63324216109d16dc41975ccc292add01d8ab16676215ade945183f` over 14045 objects, bundle 4 652 220 bytes, 431 parts (outputs/build-schema.txt, outputs/manifest-summary.json).

AC-4 The load script refuses a hash mismatch (stubbed Data API), a non-empty or untagged cluster, and rolls a failing part back.
TEST: scripts/ci/staging-db/aws-scripts.test.mjs ("load refuses a schema hash mismatch (stubbed Data API)"; "load applies each part in one Data API transaction and passes when the cluster hash matches"; "load refuses a cluster whose public schema is not empty, or that is not tagged staging"; "a failing statement rolls the part back and stops the load"; "load refuses a bundle that names production outside the reviewed allow list")

AC-5 No AWS call is made by CI and nothing is provisioned until the owner actions of design.md §6.1–6.2: provisioning is dispatch-only, fails closed without `STAGING_DB_COST_APPROVED=yes` and `AWS_STAGING_DB_ROLE_ARN`, assumes only that role, runs the guard first; the schema workflow has no credential; the scripts refuse `--apply`/load without the cost approval.
TEST: scripts/ci/staging-db/workflows.test.mjs ("AWS-STAGE-PROVISION-DB.yml: dispatch only, fail-closed owner gate, staging role only, guard first"; "STAGING-DB-SCHEMA.yml: push/dispatch, no AWS, guard report-only, bundle artifact"; and its 15 mutation cases)
TEST: scripts/ci/staging-db/aws-scripts.test.mjs ("provision --apply refuses without the cost approval, with no AWS call"; "load refuses without the cost approval (verify-only needs none)"; "provision --apply refuses credentials of another account")

AC-6 The stack carries the IAM of design.md §4 (staging-only writes, explicit production denies in role and boundary, no delete, no IAM change), the isolation SG, the own KMS key, the 60 USD budget and capacity option A by default; it creates no cluster; cfn-lint passes.
TEST: scripts/ci/staging-db/stack.test.mjs ("every production resource is denied explicitly, in the role and in the boundary"; "staging: create, modify, Data API and staging secrets are allowed; create needs the staging tag"; "any cluster other than vitana-aurora-staging cannot be created or changed"; "deletes are denied everywhere, staging included (deletion stays an owner action)"; "no IAM change is possible, except the RDS service-linked role"; "no write to ECS, EC2 or any other service: the role only creates and loads the staging cluster"; "RDS-managed master secrets: only the staging cluster's, only through RDS, no rotation grant")
TEST: scripts/ci/staging-db/stack.test.mjs ("trust: GitHub OIDC only, this repository, main only, audience sts"; "network isolation: the database SG admits 5432 only from the staging-only client SG"; "KMS: own key, rotated, retained; role use only through RDS and Secrets Manager"; "budget alarm: 60 USD a month on tag vitana-env=staging, actual and forecast, to the owner e-mail"; "capacity defaults are option A (min 0 ACU, auto-pause 300 s, max 2 ACU) and max 2 ACU is a hard cap"; "candidate services are optional, at desired count 0, and can only run the -iso task-definition families"; "no credential or secret value in the template")

Red on base: `outputs/red-on-base.txt` (5 test files fail, modules and files absent). Green: `outputs/green.txt` (80/80 with
PGlite, on 64e8361a), `outputs/green-no-install.txt` (after the review fix: 81 tests, 77 pass, 4 PGlite cases skipped, as in
UNIT.yml). Mutations: removing `DenyProduction`, the cost check or the hash comparison each fails a test
(`outputs/mutation-*.txt`); for the review fix, removing any of the four managed-secret Denies, adding `RotateSecret` back or
dropping the `aws:ViaAWSService` condition each fails a test (`outputs/mutation-managed-secret-*.txt`). `cfn-lint` exit 0.

## Decisions taken
- **Stack file is JSON in `stack.yaml`** (valid YAML; cfn-lint reads it): the plan names `stack.yaml`, and the no-install
  unit job has no YAML parser, so the tests read it as JSON (the VTID-05764 pattern).
- **Database SG admits a new staging-only client SG, not the "staging gateway/PostgREST task SGs"** of design.md §4:
  those tasks run in `sg-0fbcf7b59b1f0d685`, which the production gateway also uses (`scripts/aws/setup-kiro-runner.sh:88`),
  so admitting it would admit production tasks. Stage 3 attaches `vitana-aurora-staging-client-sg` to the isolated
  task revisions.
- **IAM additions beyond the design.md §4 table**, all scoped: `cloudformation:DescribeStacks` on this stack only (the
  provision script reads the KMS key, SG and capacity from the stack outputs); `secretsmanager:CreateSecret/TagResource`
  on `rds!cluster-*` (required by RDS for `--manage-master-user-password`, see the next item; this grant is not scoped by
  itself, the denies of the next item scope it); the staging tag condition is a separate
  explicit Deny (`CreateNeedsStagingTag`); `DenyIam` is `iam:*` with `NotResource` the RDS service-linked role (so the
  SLR statement still works); `DenyProdSecrets` also covers `vitana/gateway-awsdr/*`.
- **RDS-managed master secret (review finding on 64e8361a, corrected).** The first version allowed
  `secretsmanager:CreateSecret/TagResource/RotateSecret` on `rds!cluster-*` with no condition and called that "scoped"; it was
  not: the production master secret of `vitana-aurora-prod` has exactly that name pattern
  (`rds!cluster-eba8a4f2-3caa-4f11-88f0-c3102c3c176a-QR8ox2`, docs/AURORA-MIGRATION-STATUS-2026-09-10.md:336-338, 860-872;
  since the 2026-10-01 restore `rds!cluster-4dab93b8-…`, docs/AURORA-CUTOVER-RUNBOOK-2026-09-20.md:7,
  docs/validation/VTID-04930/commands.log:4) and `DenyProdSecrets` did not cover it. Now, in role and boundary alike:
  - `RotateSecret` is removed. The Aurora guide ("Permissions required for Secrets Manager integration") needs only
    `kms:DescribeKey`, `secretsmanager:CreateSecret` and `secretsmanager:TagResource` for create/modify/restore;
    `RotateSecret` is needed only to rotate the master password by hand, which this lane never does (RDS rotates it itself).
  - `CreateSecret/TagResource` keep the `rds!cluster-*` name (RDS chooses `rds!cluster-<cluster resource id>`, so the name
    cannot be pinned to staging in advance) and gain `Bool aws:ViaAWSService = true`: only RDS, acting on the caller's
    request, can create or tag such a secret; the role cannot call them directly. An `aws:RequestTag/vitana-env` condition,
    as the review suggested, would fail: RDS adds only its own `aws:rds:primaryDBClusterArn` tag, and `aws:`-prefixed
    tags cannot be set by a caller, so the create would always be refused.
  - Defense in depth, four explicit Denies: `DenyProdManagedSecretByName` (`secretsmanager:*` on
    `rds!cluster-4dab93b8-*` and `rds!cluster-eba8a4f2-3caa-4f11-88f0-c3102c3c176a-*`), `DenyProdManagedSecretByTag`
    (`secretsmanager:*` on any secret whose `aws:ResourceTag/aws:rds:primaryDBClusterArn` is the vitana-aurora-prod cluster
    ARN), `DenyProdManagedSecretRequestTag` (`CreateSecret/TagResource` that would label a secret for vitana-aurora-prod)
    and `DenyOtherClustersManagedSecrets` (`secretsmanager:*` on `rds!cluster-*` whose cluster tag exists and is not
    vitana-aurora-staging; the `Null` guard leaves the not-yet-existing staging secret creatable). The name Deny holds even
    if a tag is missing; the tag Denies hold if the production cluster is restored again under a new resource id.
  - Limit: the test evaluator (infra/kiro-access/lib.mjs) models only String conditions, so `aws:ViaAWSService` and
    `DenyOtherClustersManagedSecrets` are pinned structurally (with mutations), the other three Denies are evaluated.
- **Candidate services are conditional** (created only when stage 3 passes `-iso` task-definition ARNs, an app SG and a
  listener); the first apply creates none. Their task-definition parameters accept only the `vitana-gateway-iso` /
  `vitana-postgrest-aurora-staging-iso` families.
- **`BudgetAlertEmail` has no default**, so the owner command of design.md §6.2 gains `BudgetAlertEmail=<owner e-mail>`
  (docs/STAGING.md §3.3). The budget filters on the cost allocation tag `vitana-env`, which the owner may need to
  activate once.
- **`next_vtid` does not exist** in any migration (only a comment in `20251218000000_vtid_0543_atomic_create.sql:11`);
  the smoke objects are `vtid_ledger`, `oasis_events` (what `/api/v1/vtid/health` and `/api/v1/oasis/tasks` read) and
  the allocator `allocate_global_vtid`.
- **Bundle = the applied SQL files** (stub auth, 426 replayable migrations, fixtures, seed) behind `-- @@file` markers,
  not a dump: PGlite has no `pg_dump`, and replaying the same files on Aurora keeps "schema from migrations". The schema
  hash covers names, types, NOT NULL, constraint/index names, function signatures, policies and triggers, not deparsed
  bodies (their text differs between PostgreSQL versions); extension members are excluded.
- **Production references in migration text**: four found (two comments, one text row, one hard-coded production edge
  URL in `public.notify_welcome_discount()`). The function is replaced by a no-op in `seed/020`; a live check fails the
  build if any function body, default or view still names production; the four are listed in
  `bundle-prod-ref-allow.json` with exact counts, and the build fails on a new or stale entry.
- **STAGING-DB-SCHEMA.yml also runs on push to `kiro/autonomous-to-staging-r2/**`** (path-filtered), so a lane PR head
  shows the PGlite build and tests (plan §3.3 names push to `main` and dispatch; this adds lane branches, the
  MT-LOCAL-STACK.yml precedent). No `pull_request` trigger (services registry, plan §2).
- **`mode=load` builds the bundle in the same run from the dispatched commit** instead of downloading another run's
  artifact (no `actions: read` permission needed; the build is deterministic, proven by the test).
- **Guard default set** = `AWS-STAGE-*.yml`, `STAGING-DB-SCHEMA.yml`, `scripts/aws/*staging*`, `scripts/ci/staging-db/**`,
  `infra/staging-db/**` minus tests, fixtures, the guard itself and its allow list. It lists 35 references today (the
  shared plane); report-only per plan.
- **Engine version default 16.4** (≥ 16.3 needed for min 0 ACU); the script accepts any 16.x ≥ 16.3.

## Not done here (owner actions or later lanes)
- Owner: `STAGING_DB_COST_APPROVED=yes`; apply the stack (docs/STAGING.md §3.3 step 2); set `AWS_STAGING_DB_ROLE_ARN`.
- Not verified against AWS: the first real `apply`/`load` (RDS-managed secret permissions, `BYPASSRLS`/`session_replication_role`
  under `rds_superuser`, the PGlite-vs-Aurora hash equality) runs only after the owner actions; a hash mismatch fails
  that run closed.
- `staging-cutover`: fills the two placeholder secrets, attaches the client SG, creates the candidate services.

Not verified on staging: this lane deploys nothing (no gateway, frontend or database change on any running service),
so it has no staging manifest; the tests above prove it.
