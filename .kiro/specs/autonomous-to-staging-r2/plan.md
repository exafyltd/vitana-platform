---
change_class: standard
---
# plan(autonomous-to-staging-r2): protect-gate-workflow lane; isolated staging database split into three reversible stages (revision of autonomous-to-staging)
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110920-270b` (Kiro Web). Repos `exafyltd/vitana-platform`, `exafyltd/vitana-v1`.
<!-- plan:begin -->
Pins: vitana-platform `f0f88de2b55a6ca268bb6e22006f10b4908c4382`. A lane that starts on a newer head re-verifies its
citations there. Design and decision record for the staging database: `design.md` (costs, IAM, schema, auth, rollback,
impact). This is a revision of plan `autonomous-to-staging` (#5000, merged `bf1cb134e6`) under the same owner
instruction; it does not change any lane of that plan that is already built or still independent.

## 1. Goal
Owner directive 2026-11-12 ("updated owner directive … supersedes the previous assumptions for the remaining
autonomous-to-staging lanes"), quoted:
- *"Add the missing 'protect-gate-workflow' lane to the existing plan. It must: include GATE-INVARIANTS.yml in the
  protected-file list; require two independent reviewer-agent accepts for protected-file changes; verify both accepts
  against the exact current commit being merged; prevent stale reviews from authorising a newer commit; include
  automated regression tests proving the protection works; integrate with existing governance and merge mechanisms.
  Do not create a parallel governance mechanism."*
- *"Split the work into the three proposed stages: 1. AWS access foundation. 2. Isolated staging Aurora provisioning
  and synthetic data. 3. Reversible staging gateway and proxy cutover. However, this is approval to revise and
  validate the plan, not approval to incur infrastructure costs or execute the database provisioning and cutover."*
- *"Do not switch staging away from its current authentication or database configuration until a safe, reversible
  transition is demonstrated."*
- AWS access: *"Do not request production credentials, reuse the production role or weaken IAM restrictions. Stop
  only at the actual owner-controlled credential handoff."*

Unchanged: production. No production deploy, migration, DNS change or production data change. The independent r1
lanes (`pipeline-b-platform`, `pipeline-b-v1`, `quarantine`, `kiro-aws-access`, `rules-platform`, `rules-v1`) keep
their r1 lane files and VTIDs.

## 2. Today (at the pin)
- `machine-gate-protected` (VTID-05765, #5002, `e7077f27c3`) and `gate-invariants-ci` (VTID-05763, #5003,
  `e4b4b48511`) are done (closing records #5007, #5008).
- `GATE-INVARIANTS.yml` is not on the protected list: `scripts/collab/protected-gate-files.json:4-19`,
  `scripts/collab/queue.mjs:91-100` (builtin copy), `services/gateway/src/services/project-manager/governance.ts:48-63`
  (`PROTECTED_GATE_GLOBS`), `scripts/collab/gate-invariants.test.mjs:22-37` (`REQUIRED_PROTECTED`). Its static test
  `scripts/ci/workflow-trigger-check.test.mjs` is not protected either.
- Stale-review gaps in the two-model rule:
  - `land-guard.mjs merge` (`scripts/collab/land-guard.mjs:297-340`) counts an accept when `reviewCurrent` says the
    reviewed head is current. Without `--repo`, `reviewWalk` (`:232`) uses the API walk, which returns
    `prDiffSame: undefined`, so the protected-file bytes at the reviewed head are never compared to the merged head.
    A protected-file merge must always use the local walk.
  - `reviewCurrent` (`:63-75`) lets lane-file-only commits (and Project Manager lane-state commits) follow the reviewed head. That is right for single reviews;
    for protected files the plan pins it: every commit after the reviewed head may touch only the lane's own lane file,
    and the protected files' bytes at the reviewed head must equal those at the merged head.
  - The PM's `reviewOnCurrentHead` (`governance.ts:167-…`) has its own rule; the lane makes both layers agree and adds
    a shared fixture set run by both test suites.
- Nothing audits `main` after a merge: plan r1 §3.1 promised that `GATE-INVARIANTS.yml` checks every merge commit on
  `main` that touches a protected file for two distinct-model accepts on the merged head, or this plan's bootstrap
  authority, and emits OASIS `collab.gate.bypass_detected`; `gate-invariants-ci` deferred it (VTID-05763
  `acceptance.md` "Decisions taken").
- Staging data plane (details and file:line in `design.md` §1): staging gateway reads the production Supabase and
  production Aurora secrets (`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1113-1122`); the staging PostgREST proxy
  uses `vitana/aurora/prod/postgrest-authenticator-uri`
  (`.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml:30,116,139`); the staging deploy role may describe
  those production secrets (`scripts/aws/iam/eng-platform-oidc-staging-deploy-policy.json:90-104`) and has no
  `rds:Create*`. No IaC exists for `vitana-aurora-prod`. Staging sign-in uses production Supabase GoTrue
  (`services/gateway/src/routes/dev-auth.ts:142-175` uses the GoTrue admin API; `/dev/auth/token` is refused unless
  `ENVIRONMENT=dev-sandbox`, `:38-41,315-323`).
- New workflows with a `pull_request` path filter must be in the services registry
  (`scripts/eng/services-parity.test.mjs:66-81`); this plan's new workflows have no PR path filter; their static tests
  run in UNIT.yml (`scripts/**/*.test.mjs`).

## 3. Target
### 3.1 `protect-gate-workflow` (one lane, the existing mechanisms only)
1. Protected list (all four copies, kept equal by the existing invariant check): add
   `.github/workflows/GATE-INVARIANTS.yml`, `scripts/ci/workflow-trigger-check.test.mjs` and
   `scripts/collab/gate-audit.mjs`. `REQUIRED_PROTECTED` gains the same three.
2. Exact-head rule, both layers:
   - `land-guard.mjs merge`: when the PR touches a protected file, `--repo` is required (refused without it); an accept
     counts only when (a) its `Collab-Reviewed-Head` is an ancestor of the merged head, (b) every commit after it
     changes only the lane's own lane file (no merge commit, no other path), and (c) `git diff` of the protected paths
     between merge-base and reviewed head is byte-identical to that between merge-base and merged head. A PR brought
     up to date with `main` after the accepts needs new accepts on the new head (an automatic merge of `main` no longer
     carries a protected-file accept forward). Two accepts must come from two distinct chain models and two distinct
     `Collab-Session` ids, neither of which is a session in the lane's `executing` log entries (self-review exclusion).
   - `governance.ts` (`protectedAcceptModels`, `reviewOnCurrentHead`): the same three conditions from the observed PR
     (head SHA, commit list with files, review entries), the same distinct-model and distinct-session rule.
   - Shared fixtures `scripts/collab/fixtures/protected-review-cases.json` (stale head, code after review, merge of
     `main` after review, same model twice, same session twice, builder self-review, two valid accepts) are run by
     `land-guard.test.mjs` and `governance.test.ts`; both must give the same verdict per case.
3. Post-merge audit, existing workflow: `GATE-INVARIANTS.yml` gains a step `node scripts/collab/gate-audit.mjs
   --since <last 14 days> --gh exafyltd/vitana-platform` (read-only, `GITHUB_TOKEN` with `contents: read`,
   `pull-requests: read`). For each merge commit on `main` touching a protected file it reads the merged PR's commits
   and applies the same `land-guard.mjs` functions (imported, not copied). Allowed authorities: two valid accepts on
   the merged head, or the bootstrap list `scripts/collab/fixtures/gate-audit-bootstrap.json` (PR #5002 merge
   `e7077f27c3`, plus merges before the two-model rule landed, listed by SHA). A violation fails the job, and a second
   job `report` (`if: failure()`, `needs: invariants`) emits OASIS `collab.gate.bypass_detected` through the existing
   `/api/v1/events/ingest` path with `GATEWAY_SERVICE_TOKEN` (that job only; `workflow-trigger-check.test.mjs` allows a
   secret only in job `report`).
4. Nothing new besides those files: no new queue, ledger, allocator or merge path.

### 3.2 Stage 1, AWS access foundation (r1 lane `kiro-aws-access`, VTID-05764, plus `staging-db-provision` IAM)
- r1 lane `kiro-aws-access` is built as preparation only: IAM as code under `infra/kiro-access/`, policy unit tests,
  `docs/KIRO-AWS-ACCESS.md`; `AWS-KIRO-ACCESS.yml` validates (`cfn-lint`, policy tests, a read-only drift report with the
  existing drift role `vars.AWS_DRIFT_ROLE_ARN`) and never applies. This amends r1 §3.5 ("applied by a
  workflow_dispatch workflow on the existing OIDC role"): no workflow applies IAM with the production role; the owner
  applies the stacks once (exact command in `docs/KIRO-AWS-ACCESS.md` and `design.md` §6). That is the credential
  handoff stop.
- The staging database IAM (role `vitana-gha-staging-db`, `design.md` §4) is a CloudFormation template in
  `infra/staging-db/` (lane `staging-db-provision`), applied by the owner in the same handoff.

### 3.3 Stage 2, isolated staging Aurora and synthetic data (lane `staging-db-provision`)
Code and validation only; the provisioning run waits for the owner's cost approval (`design.md` §7).
- `infra/staging-db/stack.yaml` (owner-applied once): KMS key `alias/vitana-staging-db`, DB subnet group, security
  group admitting only the staging gateway and staging PostgREST task security groups, the OIDC role of `design.md` §4.
- `scripts/aws/staging-db-provision.sh --plan|--apply --cluster vitana-aurora-staging`: refuses any cluster name other
  than `vitana-aurora-staging*`, refuses `vitana-aurora-prod` unconditionally, never names a production ARN (`--plan`
  prints the calls). Creates the cluster and one serverless v2 writer with the stack's KMS key, subnet group and SG,
  `--manage-master-user-password`, Data API on, capacity from `design.md` §2 (recommended min 0, max 2 ACU,
  auto-pause 300 s), backup retention 1 day, deletion protection on, tags `vitana-env=staging`.
- Schema from migrations, built and checked in CI first: `scripts/ci/staging-db/build-schema.mjs` replays
  `supabase/migrations/**` with the existing local-stack replay (`scripts/mt/stack/stack.mjs`, skips of
  `supabase/tests/local-stack/replay-skip.json`), loads the synthetic seed (`supabase/tests/fixtures/*.sql` plus a new
  `infra/staging-db/seed/*.sql` with the documented test user `a27552a3-0257-4305-8ed0-351a80fd3701`), dumps one SQL
  bundle and a schema hash; it fails when a table of `supabase/tests/local-stack/required-tables.txt` or an object the
  gateway smoke reads (`vtid_ledger`, `next_vtid`, the OASIS tasks tables) is missing. Workflow
  `STAGING-DB-SCHEMA.yml` (push to `main` on `supabase/migrations/**` and dispatch; no PR filter) runs it and uploads
  the bundle as an artifact.
- `scripts/aws/staging-db-load.sh --cluster vitana-aurora-staging --bundle <file>`: applies the bundle through the RDS
  Data API (the statement splitter of `aurora-apply-migration.sh`), then compares the cluster's schema hash with the
  bundle's; mismatch → exit 1.
- `scripts/ci/staging-prod-ref-guard.mjs`: lists every production identifier (`inmkhvwdcuyhnxkgfvsb`,
  `vitana-aurora-prod`, `AWS_PROD_ROLE_ARN`, `vitana/aurora/prod/`, `vitana/supabase/prod/`, `*-awsdr`,
  `vitana-alb-prod`, the production KMS key ARN) found in staging workflows, staging scripts and `infra/staging-db/**`;
  `--report` (default here) prints them and exits 0; `--enforce` exits 1. It runs report-only in `STAGING-DB-SCHEMA.yml`.
  The gate invariant on it (VTID-05765) becomes active as soon as the file exists.
- `AWS-STAGE-PROVISION-DB.yml` (dispatch only; inputs `mode: plan|apply|load`): assumes `vars.AWS_STAGING_DB_ROLE_ARN`
  (never `AWS_PROD_ROLE_ARN`, never the staging deploy role); `apply`/`load` refuse unless repo variable
  `STAGING_DB_COST_APPROVED` equals `yes` (set by the owner) and the role variable is set; runs the guard in `--enforce`
  mode over its own inputs first.
- `docs/STAGING.md` rewritten for AWS (today GCP-era): current shared data plane, the isolated plane, the switch.

### 3.4 Stage 3, reversible cutover (lane `staging-cutover`)
Built and tested; the switch is only flipped after a demonstrated reversible transition and the owner's approval.
- Repo variable `STAGING_DATA_PLANE`: `shared` (default, unset = shared, exactly today's task definitions) or
  `isolated`. In `AWS-STAGE-DEPLOY-GATEWAY.yml` and `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml` one step selects the
  secret set: `shared` keeps lines `1113-1122` / `116,139` as they are; `isolated` uses `vitana/aurora/staging-db/*`
  secrets and the `vitana-aurora-staging` endpoint. Unit tests prove that `shared` produces byte-identical secret and
  env sets to today's (fixture from the pinned workflow).
- Demonstration before any flip, with no effect on the running staging services: `AWS-STAGE-CUTOVER-REHEARSAL.yml`
  (dispatch) registers the isolated task-definition revisions under the candidate services `vitana-gateway-iso` and
  `vitana-postgrest-aurora-staging-iso` (created once by the owner-applied stack; design §5), runs STAGING-VERIFY
  against the candidate URL, then scales the candidates to 0. Evidence: run URL, test counts, revision ARNs.
- Flip (`AWS-STAGE-CUTOVER.yml`, dispatch, refuses unless the latest rehearsal passed on the same commit and
  `STAGING_CUTOVER_APPROVED=yes`): records the current PRIMARY task-definition revisions of `vitana-gateway` and
  `vitana-postgrest-aurora-proxy`, sets `isolated`, deploys, runs STAGING-VERIFY; on any failure it updates both
  services back to the recorded revisions in the same job and re-runs STAGING-VERIFY (rollback criteria `design.md` §8).
- Auth during and after: unchanged issuer (production Supabase GoTrue, read-only sign-in of the test account) in both
  modes; the isolated seed holds the test account's UUID so RLS resolves. A staging-only issuer is a later plan aligned
  with the strategy's Cognito decision (`infra/cognito-migration/README.md`); `design.md` §3.
- After a successful flip and 7 days of green STAGING-VERIFY, the guard moves to `--enforce` in the staging deploy
  workflows and the production secret ARNs leave `eng-platform-oidc-staging-deploy-policy.json` (owner-applied IAM
  change, recorded in the closing evidence).

### 3.5 Re-planned dependents (same content as r1, new dependencies)
- `staging-migrations-auto` (r2): as r1 §3.4, depends on `staging-db-provision`; its `target: staging` resolves only
  to `vitana-aurora-staging` with `vars.AWS_STAGING_DB_ROLE_ARN`.
- `staging-frontend-isolation` (r2): as r1 §3.3 v1 part, depends on `staging-cutover`.
- r1 lanes `staging-db-isolation` (VTID-05771), `staging-migrations-auto` (VTID-05773) and
  `staging-frontend-isolation` (VTID-05772) are parked by the driver after this plan merges, `parked_from: ready`, log
  "superseded by autonomous-to-staging-r2/<lane>". They are never reported done.

## 4. Lanes
| Lane | Repo | Executor | Paths (summary) | Depends on |
|---|---|---|---|---|
| `protect-gate-workflow` | vitana-platform | kiro, `protected_gate: two-model` | `scripts/collab/{protected-gate-files.json,queue.mjs,land-guard.mjs,gate-invariants.test.mjs,gate-audit.mjs}`, `scripts/collab/*.test.mjs`, `scripts/collab/fixtures/**`, `governance.ts`, `services/gateway/test/**`, `.github/workflows/GATE-INVARIANTS.yml`, `scripts/ci/workflow-trigger-check.test.mjs` | none |
| `staging-db-provision` | vitana-platform | kiro | `infra/staging-db/**`, `scripts/aws/staging-db-*.sh`, `scripts/ci/staging-db/**`, `scripts/ci/staging-prod-ref-guard.mjs`, `.github/workflows/{AWS-STAGE-PROVISION-DB,STAGING-DB-SCHEMA}.yml`, `docs/STAGING.md` | none (apply waits for owner, §3.3) |
| `staging-cutover` | vitana-platform | kiro | `.github/workflows/AWS-STAGE-DEPLOY-{GATEWAY,POSTGREST-AURORA-PROXY}.yml`, `.github/workflows/AWS-STAGE-CUTOVER{,-REHEARSAL}.yml`, `scripts/aws/staging-cutover-*.{sh,mjs}`, `scripts/ci/staging-db/**` tests | `staging-db-provision` |
| `staging-migrations-auto` | vitana-platform | kiro | as r1 | `staging-db-provision` |
| `staging-frontend-isolation` | vitana-v1 | kiro | as r1 | `staging-cutover` |

Hot files: `queue.mjs`, `land-guard.mjs`, `governance.ts`, `protected-gate-files.json` (only `protect-gate-workflow`
in this plan; r1 `quarantine` and `pipeline-b-platform` do not touch them); `AWS-STAGE-DEPLOY-GATEWAY.yml` (only
`staging-cutover`). `protect-gate-workflow` changes protected files and merges under the two-model rule now on `main`
(`land-guard.mjs merge`), the first real use of it; no bootstrap authority is used.

## 5. Tests (each red on base first)
- `protect-gate-workflow`: the seven shared fixture cases give the same verdict in `land-guard.test.mjs` and
  `governance.test.ts`; `merge` without `--repo` on a protected PR is refused; gate-invariants mutation: dropping
  `GATE-INVARIANTS.yml` from any of the four lists fails; `gate-audit.mjs` on fixture commit histories: a protected
  merge with one accept, with a stale accept, or with two same-model accepts is reported; a bootstrap-listed SHA and a
  valid two-model merge pass; `workflow-trigger-check.test.mjs` asserts the audit step, the `report` job's
  `if: failure()` and that no other job uses a secret.
- `staging-db-provision`: provision `--plan` prints no production identifier and refuses `vitana-aurora-prod` and any
  non-staging name; guard fixtures (config, workflow YAML, task-definition JSON) each fail under `--enforce`;
  `build-schema.mjs` fails when a required table is dropped from the replay (fixture skip list); load script refuses a
  hash mismatch (stubbed Data API).
- `staging-cutover`: `shared` mode produces the pinned secret and env sets unchanged; `isolated` names no production
  identifier (guard `--enforce`); the flip workflow refuses without a passing rehearsal on the same commit; rollback
  path updates both services to the recorded revisions on a forced STAGING-VERIFY failure (stubbed AWS CLI).
- `staging-migrations-auto`: as r1 §5. `staging-frontend-isolation`: as r1.
STAGING-VERIFY on each merge commit that deploys; `docs/validation/<VTID>/staging-tests.json` per lane.

## 6. Risks
- Self-modifying gate (`protect-gate-workflow` edits the rule it merges under): the merge is judged by the rule on
  `main` (two-model, already live) and `gate-invariants.test.mjs` loads its baseline from `origin/main`; the new
  exact-head rule is stricter, never looser.
- Cost: none until the owner sets `STAGING_DB_COST_APPROVED=yes` and applies the stack (`design.md` §2).
- Cutover disruption: none until the flip; the rehearsal runs on candidate services; the flip reverts automatically.
- Auto-pause cold start (~15 s) can time out the first STAGING-VERIFY probe: the rehearsal measures it; fallback is
  min 0.5 ACU (`design.md` §2).
<!-- plan:end -->
