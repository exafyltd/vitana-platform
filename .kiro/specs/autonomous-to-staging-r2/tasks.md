# Tasks — autonomous-to-staging-r2
Plan: `plan.md`. Decision record: `design.md`.

<!-- lane: protect-gate-workflow -->
## Lane `protect-gate-workflow` (vitana-platform)
- [ ] T1 Add `.github/workflows/GATE-INVARIANTS.yml`, `scripts/ci/workflow-trigger-check.test.mjs`, `scripts/collab/gate-audit.mjs` to `protected-gate-files.json`, the `queue.mjs` builtin copy, `governance.ts` `PROTECTED_GATE_GLOBS` and `REQUIRED_PROTECTED`.
- [ ] T2 Exact-head rule in `land-guard.mjs merge` (local walk required, lane-file-only commits after the reviewed head, protected-path bytes equal, distinct models and sessions, builder excluded) and the same in `governance.ts`.
- [ ] T3 Shared fixtures `scripts/collab/fixtures/protected-review-cases.json`, run by `land-guard.test.mjs` and `governance.test.ts`.
- [ ] T4 `scripts/collab/gate-audit.mjs` + bootstrap list; `GATE-INVARIANTS.yml` audit step and `report` job (OASIS `collab.gate.bypass_detected`, secret only there); trigger-check test updated.

**Acceptance**
- Change types: Tooling/docs, Backend (PM merge rule), Infrastructure/CI.
- Each of the seven fixture cases gives the same verdict in both layers; a stale accept, an accept followed by a code commit or a merge of `main`, two accepts of one model, two accepts of one session and a builder self-review never authorise a protected-file merge.
- `land-guard.mjs merge` refuses a protected-file PR without `--repo`.
- Dropping `GATE-INVARIANTS.yml` from any of the four lists fails the invariant check (mutation test).
- `gate-audit.mjs` reports a protected merge without two valid accepts and passes a bootstrap-listed SHA; the first GATE-INVARIANTS run on `main` after merge is green and its URL is in `commands.log`.
- Merged through `land-guard.mjs merge` under the two-model rule (two accepts from different chain models on the merged head); no bootstrap authority.

<!-- lane: staging-db-provision -->
## Lane `staging-db-provision` (vitana-platform)
- [ ] T1 `infra/staging-db/stack.yaml` (KMS key, subnet group, SG, secrets placeholders, candidate services at 0, OIDC role + boundary of `design.md` §4, Budget alarm) and a policy unit test.
- [ ] T2 `scripts/aws/staging-db-provision.sh --plan|--apply`, `scripts/aws/staging-db-load.sh`.
- [ ] T3 `scripts/ci/staging-db/build-schema.mjs` (replay + fixtures + seed → bundle + hash), `infra/staging-db/seed/*.sql`, workflow `STAGING-DB-SCHEMA.yml` (push to main on migrations, dispatch).
- [ ] T4 `scripts/ci/staging-prod-ref-guard.mjs` (`--report` default, `--enforce`), report-only in `STAGING-DB-SCHEMA.yml`.
- [ ] T5 `AWS-STAGE-PROVISION-DB.yml` (dispatch; plan|apply|load; `vars.AWS_STAGING_DB_ROLE_ARN`; refuses apply/load unless `STAGING_DB_COST_APPROVED=yes`).
- [ ] T6 `docs/STAGING.md` rewritten for AWS.

**Acceptance**
- Change types: Infrastructure/CI, Database.
- `--plan` prints no production identifier; any cluster name outside `vitana-aurora-staging*`, and `vitana-aurora-prod`, is refused.
- The guard fails on each production-identifier fixture under `--enforce`.
- `build-schema.mjs` succeeds on `main` (schema hash and bundle size in evidence) and fails when a required table is removed from the replay (fixture).
- The load script refuses a hash mismatch (stubbed Data API).
- No AWS call is made by CI; nothing is provisioned until the owner actions of `design.md` §6.1–6.2.

<!-- lane: staging-cutover -->
## Lane `staging-cutover` (vitana-platform)
- [ ] T1 `STAGING_DATA_PLANE` switch in both staging deploy workflows; `shared` keeps today's secret and env sets byte-for-byte.
- [ ] T2 `AWS-STAGE-CUTOVER-REHEARSAL.yml` (candidate services, STAGING-VERIFY on the candidate URL, scale to 0).
- [ ] T3 `AWS-STAGE-CUTOVER.yml` (records revisions, flip, STAGING-VERIFY, automatic rollback per `design.md` §8).
- [ ] T4 `scripts/ci/staging-db/impact.mjs`: classifies every `staging-tests.json` and every workflow calling the staging gateway for ledger/OASIS writes; the flip is refused while an unclassified one remains.

**Acceptance**
- Change types: Infrastructure/CI.
- `shared` mode equals the pinned task-definition inputs (fixture test); `isolated` names no production identifier (guard `--enforce`).
- The flip refuses without a passing rehearsal on the same commit, without `STAGING_CUTOVER_APPROVED=yes`, or with an unclassified governance caller.
- Rollback restores the recorded revisions on a forced failure (stubbed AWS CLI).
- Nothing is flipped by this lane; the flip is an owner-approved dispatch after the rehearsal.

<!-- lane: staging-migrations-auto -->
## Lane `staging-migrations-auto` (vitana-platform)
As plan r1 §3.4 and r1 tasks.md, with the staging target using `vars.AWS_STAGING_DB_ROLE_ARN` and cluster `vitana-aurora-staging` only.

**Acceptance**
- Change types: Infrastructure/CI, Database.
- Target `staging` never resolves to a production cluster, project ref or `AWS_PROD_ROLE_ARN`; `staging-db-apply-migration.sh` without `--cluster`, or with `--cluster vitana-aurora-prod`, fails; rollback covered with a failing fixture migration on a local Postgres.

<!-- lane: staging-frontend-isolation -->
## Lane `staging-frontend-isolation` (vitana-v1)
As plan r1, after `staging-cutover`: the staging frontend uses only staging endpoints and keys.

**Acceptance**
- Change types: Infrastructure/CI.
- The staging frontend build names no production project ref except the auth issuer kept by `design.md` §3; STAGING-VERIFY passes.
